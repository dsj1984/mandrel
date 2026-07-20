/**
 * run-epilogue.js — real per-run closeout for `/deliver --run`.
 *
 * After the last Story in a multi-Story plan-run lands, this module:
 *   1. Selects the cross-Story audit lens roster over the combined landed
 *      tip vs base (deterministic `selectAudits` — host walks lenses).
 *   2. Rolls up friction follow-ups across every Story in the run and
 *      files/posts them on the primary Story.
 *   3. Checks sibling Spec/acceptance coherence across Story bodies.
 *
 * There is no inert planner-only path: `planRunEpilogue` enumerates steps
 * and `runPlanRunEpilogue` executes them. Single-Story runs skip the
 * epilogue (`applicable: false`).
 *
 * @module lib/orchestration/run-epilogue
 */

import { selectAudits } from '../audit-suite/index.js';
import { graduateRetroProposals } from '../feedback-loop/retro-proposals-graduator.js';
import { gitSpawn } from '../git-utils.js';
import { Logger } from '../Logger.js';
import { composeRoutedProposals } from './retro-proposals.js';
import {
  buildFollowUpsCommentBody,
  gatherRunFrictionSignals,
  resolveFollowUpRepos,
} from './story-follow-ups.js';
import { upsertStructuredComment } from './ticketing.js';

/**
 * Canonical epilogue step kinds, in execution order.
 * @type {readonly ['audit-roster', 'follow-up-rollup', 'sibling-coherence']}
 */
export const RUN_EPILOGUE_STEP_KINDS = Object.freeze([
  'audit-roster',
  'follow-up-rollup',
  'sibling-coherence',
]);

/**
 * @param {string|number|{ id?: string|number, slug?: string }} entry
 * @returns {string|null}
 */
function normalizeStoryId(entry) {
  if (typeof entry === 'string') return entry.trim() || null;
  if (typeof entry === 'number' && Number.isInteger(entry)) {
    return String(entry);
  }
  if (!entry || typeof entry !== 'object') return null;
  if (typeof entry.id === 'string' || Number.isInteger(entry.id)) {
    return String(entry.id).trim() || null;
  }
  return typeof entry.slug === 'string' ? entry.slug.trim() || null : null;
}

/**
 * @param {Array<string|number|{ id?: string|number, slug?: string }>} stories
 * @returns {string[]}
 */
function normalizeStoryIds(stories) {
  const list = Array.isArray(stories) ? stories : [];
  const seen = new Set();
  const ids = [];
  for (const entry of list) {
    const id = normalizeStoryId(entry);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

/**
 * Enumerate the ordered epilogue steps for a completed run.
 *
 * @param {object} args
 * @param {string} args.planRunId
 * @param {Array<string|number|{ id?: string|number, slug?: string }>} args.stories
 * @returns {object}
 */
export function planRunEpilogue({ planRunId, stories } = {}) {
  const ids = normalizeStoryIds(stories);
  const runId =
    typeof planRunId === 'string' && planRunId.trim() !== ''
      ? planRunId.trim()
      : null;

  if (ids.length <= 1) {
    return {
      applicable: false,
      planRunId: runId,
      stories: ids,
      steps: [],
      reason:
        ids.length === 0
          ? 'no Stories in run'
          : 'single-Story run — per-Story close is the end; no run-scoped epilogue',
    };
  }

  // Positional `/deliver 101 102` has no plan-run label. Synthesize a
  // stable adhoc id from the sorted Story set so the epilogue still
  // anchors comments / audit roster without requiring `--run`.
  const effectiveRunId =
    runId ??
    `adhoc-${[...ids].sort((a, b) => Number(a) - Number(b)).join('-')}`;

  const steps = [
    {
      kind: 'audit-roster',
      description: `Select cross-Story audit lenses for run ${effectiveRunId}`,
      stories: ids,
    },
    {
      kind: 'follow-up-rollup',
      description: `Friction follow-up roll-up for run ${effectiveRunId}`,
      stories: ids,
    },
    {
      kind: 'sibling-coherence',
      description: `Sibling-coherence check across the ${ids.length} Story specs of run ${effectiveRunId}`,
      stories: ids,
    },
  ];

  return {
    applicable: true,
    planRunId: effectiveRunId,
    stories: ids,
    steps,
  };
}

/**
 * How many first-parent commits of the base ref to scan when looking for the
 * run's landed squash-merges. The epilogue fires immediately after the run's
 * last Story lands, so the run's merges sit within the first handful of
 * commits; the limit only bounds the pathological case.
 * @type {number}
 */
const BASE_SCAN_LIMIT = 500;

/** ASCII unit separator — cannot occur in a git commit subject. */
const FIELD_SEP = '\x1f';

/**
 * Read the base ref's first-parent history as `{ sha, parents, subject }`
 * records, newest-first.
 *
 * @param {object} args
 * @param {string} args.cwd
 * @param {string} args.baseRef
 * @param {number} args.scanLimit
 * @param {{ gitSpawn: Function }} args.git
 * @returns {{ ok: true, commits: Array<{sha: string, parents: string[], subject: string}> }
 *          | { ok: false, reason: string }}
 */
function readFirstParentHistory({ cwd, baseRef, scanLimit, git }) {
  let result;
  try {
    result = git.gitSpawn(
      cwd,
      'log',
      '--first-parent',
      baseRef,
      `--max-count=${scanLimit}`,
      `--format=%H${FIELD_SEP}%P${FIELD_SEP}%s`,
    );
  } catch (err) {
    return {
      ok: false,
      reason: `\`git log ${baseRef}\` could not be spawned: ${err?.message ?? String(err)}`,
    };
  }
  if (result?.status !== 0) {
    const detail =
      String(result?.stderr ?? '').split('\n')[0] || 'unknown error';
    return {
      ok: false,
      reason: `\`git log ${baseRef}\` failed (is \`${baseRef}\` fetched?): ${detail}`,
    };
  }
  const commits = String(result.stdout ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [sha, parents, ...rest] = line.split(FIELD_SEP);
      return {
        sha,
        parents: parents ? parents.split(' ').filter(Boolean) : [],
        subject: rest.join(FIELD_SEP),
      };
    });
  return { ok: true, commits };
}

/**
 * One trailing `(#<n>)` / `(refs #<n>)` marker, anchored at the end of what
 * is left of a subject after the markers to its right have been peeled off.
 */
const TRAILING_MARKER_RE = /\s*\((?:refs\s+)?#(\d+)\)$/;

/**
 * Peel the **trailing run** of `(#<n>)` markers off a squash subject.
 *
 * The shape this parses is fixed by the close pipeline plus GitHub: the PR
 * title `normalizePrTitle` writes ends with `(#<storyId>)`, and GitHub's
 * squash appends ` (#<prNumber>)` to it — so a landed Story merge reads
 * `<subject> (#<storyId>) (#<prNumber>)` and the Story's own marker is the
 * *second-to-last* marker, not the last one. Both are returned; the caller
 * decides which ids it cares about.
 *
 * Why the trailing run rather than a substring scan (the bug this replaces):
 * `subject.includes('(#101)')` matched the id **anywhere**, so an unrelated
 * later commit quoting an old marker — canonically a revert, whose subject
 * embeds the reverted title verbatim: `revert: "fix: x (#101) (#900)" (#950)`
 * — anchored the run on a far-older commit and inflated the roster diff with
 * everything in between. Peeling from the right stops at the first character
 * that is not part of a marker (the closing quote, above), so a quoted marker
 * is structurally out of reach.
 *
 * The `refs #` form is accepted because it is the other PR-title shape this
 * repo's own history carries (`feat(x): … (refs #4575) (#4582)`) — the
 * `refs #<id>` convention from `rules/git-conventions.md`. A plain substring
 * scan for `(#4575)` never matched those at all.
 *
 * @param {string} subject
 * @returns {number[]} Marker ids, right-to-left (PR number first).
 */
function trailingMarkerIds(subject) {
  const ids = [];
  let rest = typeof subject === 'string' ? subject.trimEnd() : '';
  for (;;) {
    const match = TRAILING_MARKER_RE.exec(rest);
    if (!match) return ids;
    ids.push(Number(match[1]));
    rest = rest.slice(0, match.index).trimEnd();
  }
}

/**
 * Resolve the **pre-run base sha**: the commit the base branch pointed at
 * before the run's first Story landed.
 *
 * Why not `origin/main...HEAD` (the bug this replaces): the epilogue runs
 * *after* the run's last Story lands, so HEAD in the main checkout is either
 * `origin/main` itself or an ancestor of it. The three-dot merge-base is then
 * HEAD, and the diff is empty **by construction** — it never reported the
 * run's real diff. Rolling HEAD back does not help, so branch-reaping /
 * cleanup ordering is not the cause; the refs being compared are.
 *
 * The derivation walks the base ref's first-parent history for the run's
 * landed squash-merges. Every Story PR title carries a `(#<storyId>)` suffix
 * (guaranteed by `normalizePrTitle` in the close pipeline) and GitHub uses the
 * PR title as the squash subject, so the marker is a reliable, offline handle
 * that does **not** depend on the Story branches still existing. The earliest
 * such merge's first parent is the pre-run base.
 *
 * @param {object} args
 * @param {Array<string|number>} args.stories - Story ids in the run.
 * @param {string} args.cwd
 * @param {string} [args.baseRef] - Remote-tracking base ref, e.g. `origin/main`.
 * @param {number} [args.scanLimit]
 * @param {{ gitSpawn: Function }} [args.git]
 * @returns {{ resolved: true, baseSha: string, mergeSha: string, storyId: number, baseRef: string }
 *          | { resolved: false, reason: string, baseRef: string }}
 */
export function resolveRunBaseSha({
  stories,
  cwd,
  baseRef = 'origin/main',
  scanLimit = BASE_SCAN_LIMIT,
  git = { gitSpawn },
} = {}) {
  const ids = (Array.isArray(stories) ? stories : [])
    .map(Number)
    .filter((n) => Number.isInteger(n) && n > 0);
  if (ids.length === 0) {
    return {
      resolved: false,
      baseRef,
      reason:
        'the run carries no numeric Story ids to match landed merges against',
    };
  }

  const history = readFirstParentHistory({ cwd, baseRef, scanLimit, git });
  if (!history.ok) {
    return { resolved: false, baseRef, reason: history.reason };
  }

  // `git log` is newest-first; walk backwards so the first hit is the
  // *earliest* merge belonging to the run.
  const wanted = new Set(ids);
  for (let i = history.commits.length - 1; i >= 0; i -= 1) {
    const commit = history.commits[i];
    const hit = trailingMarkerIds(commit.subject).find((id) => wanted.has(id));
    if (hit === undefined) continue;
    const baseSha = commit.parents[0];
    if (!baseSha) {
      return {
        resolved: false,
        baseRef,
        reason: `the earliest landed merge for the run (${commit.sha}, Story #${hit}) is a root commit — it has no first parent to use as the pre-run base`,
      };
    }
    return {
      resolved: true,
      baseRef,
      baseSha,
      mergeSha: commit.sha,
      storyId: hit,
    };
  }

  return {
    resolved: false,
    baseRef,
    reason: `no landed squash-merge carrying a \`(#<storyId>)\` marker for ${ids
      .map((id) => `#${id}`)
      .join(
        ', ',
      )} was found in the last ${scanLimit} first-parent commits of \`${baseRef}\` — has the run landed?`,
  };
}

/**
 * List the files the run changed: `<pre-run base>...<baseRef>`.
 *
 * @returns {{ ok: true, files: string[] } | { ok: false, reason: string }}
 */
function listChangedFiles({ cwd, baseSha, headRef, git }) {
  const range = `${baseSha}...${headRef}`;
  let result;
  try {
    result = git.gitSpawn(cwd, 'diff', '--name-only', range);
  } catch (err) {
    return {
      ok: false,
      reason: `\`git diff ${range}\` could not be spawned: ${err?.message ?? String(err)}`,
    };
  }
  if (result?.status !== 0) {
    const detail =
      String(result?.stderr ?? '').split('\n')[0] || 'unknown error';
    return { ok: false, reason: `\`git diff ${range}\` failed: ${detail}` };
  }
  return {
    ok: true,
    files: String(result.stdout ?? '')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean),
  };
}

/**
 * Resolve the run's combined landed diff, or an explicit reason it could not
 * be computed. Never conflates "could not compute" with "zero files changed".
 *
 * @returns {{ resolved: boolean, changedFiles: string[], baseSha: string|null,
 *             mergeSha: string|null, baseRef: string, reason: string|null }}
 */
function resolveCombinedDiff({ stories, cwd, baseRef, git }) {
  const base = resolveRunBaseSha({ stories, cwd, baseRef, git });
  if (!base.resolved) {
    return {
      resolved: false,
      changedFiles: [],
      baseSha: null,
      mergeSha: null,
      baseRef,
      reason: base.reason,
    };
  }
  const diff = listChangedFiles({
    cwd,
    baseSha: base.baseSha,
    headRef: baseRef,
    git,
  });
  if (!diff.ok) {
    return {
      resolved: false,
      changedFiles: [],
      baseSha: base.baseSha,
      mergeSha: base.mergeSha,
      baseRef,
      reason: diff.reason,
    };
  }
  return {
    resolved: true,
    changedFiles: diff.files,
    baseSha: base.baseSha,
    mergeSha: base.mergeSha,
    baseRef,
    reason: null,
  };
}

/**
 * The diff line of the roster comment. An unresolved base MUST read as a
 * loud failure, never as `Changed files considered: 0`.
 *
 * @param {ReturnType<typeof resolveCombinedDiff>} diff
 * @returns {string[]}
 */
function renderDiffLines(diff) {
  if (!diff.resolved) {
    return [
      '> ⚠️ **Combined landed diff unavailable — this is NOT "zero files changed".**',
      `> The pre-run base sha could not be resolved: ${diff.reason}`,
      '> Walk the lenses below against the run diff determined by hand.',
      '> Lens selection was **keyword-only**: with no change set, no lens',
      '> `filePatterns` trigger could fire, so the roster below reflects the',
      "> primary Story's prose rather than what the run touched. Treat it as a",
      '> starting point, not a roster.',
    ];
  }
  return [
    `Combined landed diff \`${diff.baseSha}...${diff.baseRef}\` — ` +
      `**${diff.changedFiles.length}** changed file(s).`,
  ];
}

/**
 * @param {object} config
 * @returns {string} the remote-tracking base ref, e.g. `origin/main`.
 */
function resolveBaseRef(config) {
  const baseBranch = config?.project?.baseBranch;
  const branch =
    typeof baseBranch === 'string' && baseBranch.trim() !== ''
      ? baseBranch.trim()
      : 'main';
  return `origin/${branch}`;
}

async function executeAuditRoster({
  planRunId,
  stories,
  cwd,
  provider,
  config,
  git,
  selectAuditsFn,
}) {
  const primaryId = Number(stories[0]);
  const diff = resolveCombinedDiff({
    stories,
    cwd,
    baseRef: resolveBaseRef(config),
    git,
  });
  // Hand `selectAudits` the change set we just resolved — never a git range for
  // it to re-derive. This function runs in the main checkout *after* the run's
  // Stories merged, so every range it could name (`main...HEAD`) is empty by
  // construction; asking for one is how the roster came to select lenses from
  // zero files while printing the correct file list beside them (Story #4571).
  const lensGrounding = diff.resolved ? 'diff' : 'keyword-only';
  let selectedAudits = [];
  if (Number.isInteger(primaryId) && primaryId > 0) {
    const selected = await selectAuditsFn({
      ticketId: primaryId,
      gate: 'gate3',
      provider,
      changedFiles: diff.resolved ? diff.changedFiles : [],
    });
    selectedAudits = Array.isArray(selected?.selectedAudits)
      ? selected.selectedAudits
      : Array.isArray(selected)
        ? selected
        : [];
  }
  if (!diff.resolved) {
    Logger.warn(
      `[run-epilogue] plan-run ${planRunId}: combined landed diff unavailable — ${diff.reason}`,
    );
  }
  const body = [
    '### plan-run-audit-roster',
    '',
    `Cross-Story audit roster for plan-run \`${planRunId}\`.`,
    '',
    ...renderDiffLines(diff),
    '',
    `**Selected lenses** (host MUST walk each against the combined landed diff) — ` +
      `grounding: \`${lensGrounding}\`:`,
    ...(selectedAudits.length > 0
      ? selectedAudits.map((lens) => `- \`${lens}\``)
      : ['- _(none — docs-only or no matching change-set lenses)_']),
    '',
    '```json',
    JSON.stringify(
      {
        planRunId,
        stories: stories.map(Number),
        baseResolution: {
          resolved: diff.resolved,
          baseRef: diff.baseRef,
          baseSha: diff.baseSha,
          mergeSha: diff.mergeSha,
          reason: diff.reason,
        },
        changedFiles: diff.resolved ? diff.changedFiles : null,
        lensGrounding,
        selectedAudits,
      },
      null,
      2,
    ),
    '```',
  ].join('\n');
  if (Number.isInteger(primaryId) && primaryId > 0) {
    await upsertStructuredComment(
      provider,
      primaryId,
      'plan-run-audit-roster',
      body,
    );
  }
  return {
    kind: 'audit-roster',
    selectedAudits,
    // Whether the lenses above were chosen from the run's landed files
    // (`diff`) or, with no resolvable base, from the primary Story's prose
    // alone (`keyword-only`). The two are not interchangeable: a keyword-only
    // roster cannot select a lens that declares no keywords, so its silence
    // about a lens says nothing about the code.
    lensGrounding,
    // `null` — not `0` — when unresolved: a zero count must only ever mean
    // "the run genuinely changed nothing".
    changedFileCount: diff.resolved ? diff.changedFiles.length : null,
    changedFiles: diff.resolved ? diff.changedFiles : null,
    baseResolution: {
      resolved: diff.resolved,
      baseRef: diff.baseRef,
      baseSha: diff.baseSha,
      mergeSha: diff.mergeSha,
      reason: diff.reason,
    },
  };
}

async function executeFollowUpRollup({
  planRunId,
  stories,
  provider,
  config,
  cwd,
}) {
  // Shared with the story-scoped gather (Story #4649): `storyId` + `details`
  // are what the composer's recovery-netting keys on, and two hand-rolled
  // copies of this loop are how they got dropped in the first place.
  const signals = await gatherRunFrictionSignals(stories, config);
  const repos = resolveFollowUpRepos(config);
  const primaryId = Number(stories[0]);
  const proposals = composeRoutedProposals({
    anchorId: Number.isInteger(primaryId) ? primaryId : 1,
    anchorKind: 'run',
    frameworkRepo: repos.frameworkRepo,
    consumerRepo: repos.consumerRepo,
    signals,
    unresolvedBlockedEvents: [],
  });
  // Patch titles to mention the plan-run token (anchorKind run uses numeric id).
  for (const item of [...proposals.framework, ...proposals.consumer]) {
    item.title = item.title.replace(/plan-run \d+/, `plan-run ${planRunId}`);
    item.body = item.body.replace(/plan-run \d+/g, `plan-run ${planRunId}`);
  }
  const graduated = await graduateRetroProposals({
    epicId: primaryId,
    provider,
    config,
    currentRepo: repos.currentRepo,
    frameworkRepo: (() => {
      const [owner, repo] = repos.frameworkRepo.split('/');
      return { owner, repo };
    })(),
    routedProposals: proposals,
    cwd,
  });
  if (Number.isInteger(primaryId) && primaryId > 0) {
    const body = buildFollowUpsCommentBody({
      storyId: primaryId,
      proposals,
      graduated,
      // Story #4578 — the run's Story count is what lets an empty roll-up
      // render as a flagged claim ("0 signals across N Stories") rather than
      // as "nothing to follow up".
      storyCount: stories.length,
    }).replace(
      `from Story #${primaryId}`,
      `from plan-run \`${planRunId}\` (primary Story #${primaryId})`,
    );
    await upsertStructuredComment(provider, primaryId, 'follow-ups', body);
  }
  return {
    kind: 'follow-up-rollup',
    signalCount: signals.length,
    storyCount: stories.length,
    filed: graduated.filed?.length ?? 0,
    // Story #4578 — zero signals across a multi-Story run is a claim, not a
    // clean bill of health. Surfaced on the step result so the CLI can warn
    // the operator without re-deriving it from the comment prose.
    emptyRollupSuspect: signals.length === 0 && stories.length > 1,
  };
}

function extractSection(body, heading) {
  if (typeof body !== 'string') return '';
  const re = new RegExp(
    `(?:^|\\n)## ${heading}\\s*\\n([\\s\\S]*?)(?=\\n## |$)`,
    'i',
  );
  const match = body.match(re);
  return match ? match[1].trim() : '';
}

async function executeSiblingCoherence({ planRunId, stories, provider }) {
  const findings = [];
  const bodies = [];
  for (const raw of stories) {
    const sid = Number(raw);
    if (!Number.isInteger(sid) || sid <= 0) continue;
    const ticket = await provider.getTicket(sid);
    bodies.push({
      id: sid,
      title: ticket?.title ?? '',
      acceptance: extractSection(ticket?.body ?? '', 'Acceptance'),
      spec: extractSection(ticket?.body ?? '', 'Spec'),
    });
  }
  const withAcceptance = bodies.filter((b) => b.acceptance.length > 0);
  if (withAcceptance.length > 0 && withAcceptance.length < bodies.length) {
    const missing = bodies
      .filter((b) => b.acceptance.length === 0)
      .map((b) => `#${b.id}`);
    findings.push(
      `Stories missing ## Acceptance while siblings declare ACs: ${missing.join(', ')}`,
    );
  }
  // Detect identical non-empty Spec blobs (likely copy-paste drift).
  const specMap = new Map();
  for (const b of bodies) {
    if (!b.spec) continue;
    const key = b.spec.replace(/\s+/g, ' ').slice(0, 400);
    if (!specMap.has(key)) specMap.set(key, []);
    specMap.get(key).push(b.id);
  }
  for (const ids of specMap.values()) {
    if (ids.length > 1) {
      findings.push(
        `Duplicate ## Spec prose across Stories ${ids.map((id) => `#${id}`).join(', ')} — split or dedupe.`,
      );
    }
  }
  const primaryId = Number(stories[0]);
  const body = [
    '### plan-run-sibling-coherence',
    '',
    `Sibling-coherence check for plan-run \`${planRunId}\`.`,
    '',
    findings.length === 0
      ? '_No coherence findings._'
      : findings.map((f) => `- ${f}`).join('\n'),
    '',
    '```json',
    JSON.stringify(
      { planRunId, stories: stories.map(Number), findings },
      null,
      2,
    ),
    '```',
  ].join('\n');
  if (Number.isInteger(primaryId) && primaryId > 0) {
    await upsertStructuredComment(
      provider,
      primaryId,
      'plan-run-sibling-coherence',
      body,
    );
  }
  return { kind: 'sibling-coherence', findings };
}

/**
 * Execute the per-run epilogue. Throws only on programmer misuse; step
 * failures are collected into `errors[]`.
 *
 * @param {object} args
 * @param {string} args.planRunId
 * @param {Array<string|number>} args.stories
 * @param {object} args.provider
 * @param {object} [args.config]
 * @param {string} [args.cwd]
 * @param {{ gitSpawn: Function }} [args.git] - Injection seam for tests.
 * @param {typeof selectAudits} [args.selectAuditsFn] - Injection seam for tests.
 * @returns {Promise<object>}
 */
export async function runPlanRunEpilogue({
  planRunId,
  stories,
  provider,
  config,
  cwd = process.cwd(),
  git = { gitSpawn },
  selectAuditsFn = selectAudits,
} = {}) {
  const plan = planRunEpilogue({ planRunId, stories });
  if (!plan.applicable) {
    return { ...plan, results: [], errors: [] };
  }
  if (!provider || typeof provider.getTicket !== 'function') {
    throw new TypeError('runPlanRunEpilogue requires a ticketing provider');
  }

  const results = [];
  const errors = [];
  for (const step of plan.steps) {
    try {
      if (step.kind === 'audit-roster') {
        results.push(
          await executeAuditRoster({
            planRunId: plan.planRunId,
            stories: plan.stories,
            cwd,
            provider,
            config,
            git,
            selectAuditsFn,
          }),
        );
      } else if (step.kind === 'follow-up-rollup') {
        results.push(
          await executeFollowUpRollup({
            planRunId: plan.planRunId,
            stories: plan.stories,
            provider,
            config,
            cwd,
          }),
        );
      } else if (step.kind === 'sibling-coherence') {
        results.push(
          await executeSiblingCoherence({
            planRunId: plan.planRunId,
            stories: plan.stories,
            provider,
          }),
        );
      }
    } catch (err) {
      const message = err?.message ?? String(err);
      Logger.warn(`[run-epilogue] step ${step.kind} failed: ${message}`);
      errors.push({ kind: step.kind, message });
    }
  }

  return {
    applicable: true,
    planRunId: plan.planRunId,
    stories: plan.stories,
    steps: plan.steps,
    results,
    errors,
  };
}
