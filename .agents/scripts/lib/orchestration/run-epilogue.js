/**
 * Per-run closeout after the last Story of a multi-Story run lands: optional
 * audit roster, friction roll-up, and a read-only container-Epic report.
 * Single-Story runs are `applicable: false`.
 *
 * @module lib/orchestration/run-epilogue
 */

import { selectAudits } from '../audit-suite/index.js';
import { graduateRetroProposals } from '../feedback-loop/retro-proposals-graduator.js';
import { gitSpawn } from '../git-utils.js';
import { Logger } from '../Logger.js';
import { gatherRunTelemetry } from '../observability/close-telemetry.js';
import { isEpicTicket } from './epic-container.js';
import { composeRoutedProposals } from './retro-proposals.js';
import {
  assessRollupOutcome,
  buildFollowUpsCommentBody,
  gatherRunFrictionSignals,
  publishFollowUpsRollup,
  resolveFollowUpRepos,
  summarizeSignalCategories,
} from './story-follow-ups.js';
import { upsertStructuredComment } from './ticketing.js';

/**
 * Step kinds in execution order. `audit-roster` is opt-in (`--audit-roster`)
 * because it costs a sub-agent per lens; the other two are reporting.
 *
 * @type {readonly ['audit-roster', 'follow-up-rollup', 'epic-close']}
 */
export const RUN_EPILOGUE_STEP_KINDS = Object.freeze([
  'audit-roster',
  'follow-up-rollup',
  'epic-close',
]);

/**
 * Report which container Epics are closed vs still open. Read-only: each land
 * tail already derived its container, so a pending Epic here means a tail's
 * rollup declined to close. Unreadable containers are omitted.
 *
 * @param {{ stories: string[], provider: object }} opts
 * @returns {Promise<{ kind: string, closed: number[], pending: number[] }>}
 */
async function executeEpicClose({ stories, provider }) {
  const closed = new Set();
  const pending = new Set();
  // Siblings share a container: report each Epic once.
  const seen = new Set();

  for (const raw of stories) {
    const storyId = Number(raw);
    if (!Number.isInteger(storyId) || storyId <= 0) continue;
    const epic = await readContainerFor({ storyId, provider });
    if (!epic) continue;
    const epicId = Number(epic.id);
    if (!Number.isInteger(epicId) || seen.has(epicId)) continue;
    seen.add(epicId);
    if (String(epic.state ?? '').toLowerCase() === 'closed') {
      closed.add(epicId);
    } else {
      pending.add(epicId);
    }
  }

  return {
    kind: 'epic-close',
    closed: [...closed],
    pending: [...pending],
  };
}

/**
 * Null on any failure or a provider without `getParentIssue` — omitted, never
 * guessed.
 *
 * @param {{ storyId: number, provider: object }} opts
 * @returns {Promise<object|null>}
 */
async function readContainerFor({ storyId, provider }) {
  if (typeof provider?.getParentIssue !== 'function') return null;
  try {
    const parent = await provider.getParentIssue(storyId);
    return parent && isEpicTicket(parent) ? parent : null;
  } catch (err) {
    Logger.warn(
      `[run-epilogue] could not read the container for Story #${storyId} ` +
        `(${err?.message ?? err}); omitting it from the Epic report.`,
    );
    return null;
  }
}

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
 * @param {object} args
 * @param {string} args.planRunId
 * @param {Array<string|number|{ id?: string|number, slug?: string }>} args.stories
 * @param {boolean} [args.auditRoster] Default `false`.
 * @returns {object}
 */
export function planRunEpilogue({
  planRunId,
  stories,
  auditRoster = false,
} = {}) {
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

  // Positional delivery has no plan-run label: synthesize a stable adhoc id.
  const effectiveRunId =
    runId ??
    `adhoc-${[...ids].sort((a, b) => Number(a) - Number(b)).join('-')}`;

  const steps = [
    ...(auditRoster
      ? [
          {
            kind: 'audit-roster',
            description: `Select cross-Story audit lenses for run ${effectiveRunId}`,
            stories: ids,
          },
        ]
      : []),
    {
      kind: 'follow-up-rollup',
      description: `Friction follow-up roll-up for run ${effectiveRunId}`,
      stories: ids,
    },
    {
      kind: 'epic-close',
      description: `Report the container Epic state the land tails of run ${effectiveRunId} left behind`,
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
 * The run's merges sit near the tip; this only bounds the pathological case.
 * @type {number}
 */
const BASE_SCAN_LIMIT = 500;

/** ASCII unit separator — cannot occur in a git commit subject. */
const FIELD_SEP = '\x1f';

/**
 * Newest-first.
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

const TRAILING_MARKER_RE = /\s*\((?:refs\s+)?#(\d+)\)$/;

/**
 * Peel the trailing run of `(#<n>)` / `(refs #<n>)` markers off a squash
 * subject (`<title> (#<storyId>) (#<prNumber>)`). Only the trailing run
 * counts, so a revert quoting an old title can't anchor the run on an ancient commit.
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
 * The commit the base pointed at before the run's first Story landed: the
 * first parent of the earliest first-parent squash-merge carrying a run
 * Story's `(#<storyId>)` marker. `origin/main...HEAD` would be empty by
 * construction, since the epilogue runs after the last land.
 *
 * @param {object} args
 * @param {Array<string|number>} args.stories
 * @param {string} args.cwd
 * @param {string} [args.baseRef] - e.g. `origin/main`.
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

  // Walk oldest-first so the first hit is the run's earliest merge.
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
 * Never conflates "could not compute" with "zero files changed".
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
 * An unresolved base reads as a loud failure, never as zero files.
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

/**
 * @param {object} args
 * @returns {string}
 */
function renderAuditRosterBody({
  planRunId,
  stories,
  diff,
  lensGrounding,
  selectedAudits,
}) {
  return [
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
    // Lenses are read-only and independent; state the fan-out shape explicitly.
    '**Dispatch shape (MUST): flat, parallel, one turn.** Spawn one ' +
      '`auditor` sub-agent per lens listed above and issue every one of those ' +
      'spawns in a SINGLE turn — no nested fan-out, no serial walk. A ' +
      'coordinator sub-agent that re-dispatches the lenses is the failure ' +
      'this line exists to prevent: a grandchild routes its findings to the ' +
      'wrong parent or loses them outright.',
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
  // Pass the resolved change set, never a range: post-merge, any range
  // `selectAudits` could derive is empty by construction.
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
  const body = renderAuditRosterBody({
    planRunId,
    stories,
    diff,
    lensGrounding,
    selectedAudits,
  });
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
    // A keyword-only roster's silence about a lens says nothing about the code.
    lensGrounding,
    // `null`, not `0`, when unresolved.
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

/**
 * @param {object} args
 * @returns {object}
 */
function composeRunProposals({
  primaryId,
  planRunId,
  stories,
  signals,
  config,
}) {
  const repos = resolveFollowUpRepos(config);
  return composeRoutedProposals({
    anchorId: Number.isInteger(primaryId) ? primaryId : 1,
    anchorKind: 'run',
    runToken: String(planRunId ?? ''),
    anchorStoryIds: stories,
    frameworkRepo: repos.frameworkRepo,
    consumerRepo: repos.consumerRepo,
    signals,
    unresolvedBlockedEvents: [],
  });
}

/**
 * @param {object} args
 * @returns {Promise<object>}
 */
function fileRunProposals({
  primaryId,
  proposals,
  provider,
  config,
  cwd,
  graduateFn,
}) {
  const repos = resolveFollowUpRepos(config);
  return graduateFn({
    epicId: primaryId,
    provider,
    config,
    currentRepo: repos.currentRepo,
    frameworkRepo: repos.repos.framework,
    platformRepo: repos.repos.platform,
    routedProposals: proposals,
    cwd,
  });
}

async function executeFollowUpRollup({
  planRunId,
  stories,
  provider,
  config,
  cwd,
  graduateFn = graduateRetroProposals,
}) {
  const { signals, window: frictionWindow } = await gatherRunFrictionSignals(
    stories,
    config,
  );
  const primaryId = Number(stories[0]);
  const proposals = composeRunProposals({
    primaryId,
    planRunId,
    stories,
    signals,
    config,
  });
  const graduated = await fileRunProposals({
    primaryId,
    proposals,
    provider,
    config,
    cwd,
    graduateFn,
  });
  const categories = summarizeSignalCategories(signals);
  const telemetry = await gatherRunTelemetrySafely(stories, config);
  const proposalCount = proposals.framework.length + proposals.consumer.length;
  const outcome = assessRollupOutcome({
    signalCount: signals.length,
    proposalCount,
    discardedCount: proposals.discarded.length,
    filedCount: graduated.filed?.length ?? 0,
    filingErrors: graduated.errors,
    filingSkipped: graduated.skipped,
  });
  await publishRunRollup({
    primaryId,
    planRunId,
    provider,
    config,
    proposals,
    graduated,
    storyCount: stories.length,
    signalCount: signals.length,
    categories,
    filedCount: graduated.filed?.length ?? 0,
  });
  return buildRollupStepResult({
    signals,
    storyCount: stories.length,
    graduated,
    proposals,
    proposalCount,
    categories,
    outcome,
    frictionWindow,
    telemetry,
  });
}

/**
 * On the step result only, never the roll-up comment: telemetry stays local.
 * A read failure is a missing metric (`null`), never a failed step.
 *
 * @param {Array<string|number>} stories
 * @param {object} [config]
 * @returns {Promise<object|null>}
 */
async function gatherRunTelemetrySafely(stories, config) {
  try {
    return await gatherRunTelemetry(stories, config);
  } catch (err) {
    Logger.warn(
      `[run-epilogue] run telemetry unavailable: ${err?.message ?? err}`,
    );
    return null;
  }
}

/**
 * @param {object} args
 * @returns {Promise<void>}
 */
async function publishRunRollup({
  primaryId,
  planRunId,
  provider,
  config,
  proposals,
  graduated,
  storyCount,
  signalCount,
  categories,
  filedCount,
}) {
  if (!Number.isInteger(primaryId) || primaryId <= 0) return;
  const body = buildFollowUpsCommentBody({
    storyId: primaryId,
    proposals,
    graduated,
    storyCount,
    signalCount,
    categories,
  }).replace(
    `from Story #${primaryId}`,
    `from plan-run \`${planRunId}\` (primary Story #${primaryId})`,
  );
  await publishFollowUpsRollup({
    anchorId: primaryId,
    body,
    filedCount,
    provider,
    config,
  });
}

/**
 * The step result carries every suspect flag so the CLI never regexes the
 * comment body.
 *
 * @param {object} args
 * @returns {object}
 */
function buildRollupStepResult({
  signals,
  storyCount,
  graduated,
  proposals,
  proposalCount,
  categories,
  outcome,
  frictionWindow,
  telemetry = null,
}) {
  return {
    kind: 'follow-up-rollup',
    signalCount: signals.length,
    storyCount,
    filed: graduated.filed?.length ?? 0,
    // What the age window excluded, so a bounded corpus is distinguishable.
    frictionWindow,
    proposalCount,
    categories,
    filingErrors: Array.isArray(graduated.errors) ? graduated.errors : [],
    filingSkipped: outcome.blockingSkipReasons,
    zeroProposalSuspect: outcome.zeroProposals,
    unfiledProposalSuspect: outcome.unfiledProposals,
    discarded: proposals.discarded.map((item) => ({
      category: item.category,
      occurrences: item.occurrences,
      source: item.source,
      storyCount: item.storyCount ?? null,
      tools: item.tools ?? [],
      fingerprint: item.fingerprint ?? null,
    })),
    emptyRollupSuspect: signals.length === 0 && storyCount > 1,
    telemetry,
  };
}

/**
 * Throws only on programmer misuse; step failures collect into `errors[]`.
 *
 * @param {object} args
 * @param {string} args.planRunId
 * @param {Array<string|number>} args.stories
 * @param {object} args.provider
 * @param {object} [args.config]
 * @param {string} [args.cwd]
 * @param {{ gitSpawn: Function }} [args.git]
 * @param {typeof selectAudits} [args.selectAuditsFn]
 * @param {typeof graduateRetroProposals} [args.graduateFn]
 * @param {boolean} [args.auditRoster] Default `false`.
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
  graduateFn = graduateRetroProposals,
  auditRoster = false,
} = {}) {
  const plan = planRunEpilogue({ planRunId, stories, auditRoster });
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
            graduateFn,
          }),
        );
      } else if (step.kind === 'epic-close') {
        results.push(
          await executeEpicClose({ stories: plan.stories, provider }),
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
