/**
 * plan-context.js — builds the single JSON planner-context envelope for
 * `/mandrel-plan` (modes: seed, seed-file, tickets, amends). No GitHub
 * writes; I/O is the injected provider's reads plus best-effort local scans.
 */

import { readFile } from 'node:fs/promises';
import { readAuditRulesSync } from '../audit-suite/audit-rules-reader.js';
import {
  hasWebSurface,
  matchesAnyFilePattern,
} from '../audit-suite/selector.js';
import { findSimilarOpenStories } from '../duplicate-search.js';
import { Logger } from '../Logger.js';
import { parse as parseStoryBody } from '../story-body/story-body.js';
import {
  renderStoryAuthorCore,
  renderStorySplitRules,
  ticketsModePromptField,
} from '../templates/decomposer-prompts.js';
import { concurrentMap, FANOUT_CONCURRENCY } from '../util/concurrent-map.js';
import { buildComplexitySignals } from './complexity-gate.js';
import { findDependencyCandidates } from './dependency-candidates.js';
import { buildDocsDigest } from './docs-digest.js';
import { findOpenEpicCandidates } from './epic-candidates.js';
import { buildAuthoringContext } from './planning/authoring-context.js';

/**
 * The only bound on envelope size: ~2× a measured ~120 KB seed-mode envelope.
 * Raise only with a measured justification.
 */
export const PLAN_CONTEXT_ENVELOPE_BYTE_CEILING = 256_000;

const TRUNCATION_MARKER =
  '\n\n[… truncated by plan-context: PLAN_CONTEXT_ENVELOPE_BYTE_CEILING …]';

const MAX_TRUNCATION_ROUNDS = 8;

/**
 * @param {unknown} value
 * @returns {number}
 */
function jsonBytes(value) {
  return Buffer.byteLength(JSON.stringify(value) ?? '', 'utf-8');
}

/**
 * @param {string} text
 * @param {number} excess
 * @returns {string}
 */
function truncateString(text, excess) {
  // A second cut of the same field must not stack a second marker.
  const bare = text.endsWith(TRUNCATION_MARKER)
    ? text.slice(0, -TRUNCATION_MARKER.length)
    : text;
  const keep = Math.max(
    0,
    Buffer.byteLength(bare, 'utf-8') - excess - TRUNCATION_MARKER.length,
  );
  return `${Buffer.from(bare, 'utf-8').subarray(0, keep).toString('utf-8')}${TRUNCATION_MARKER}`;
}

/**
 * Cut one field by ~`excess` bytes: a string to a prefix, an array by tail
 * entries, an object by its largest string property. `null` if uncuttable.
 *
 * @param {unknown} value
 * @param {number} excess
 * @returns {{ value: unknown, note: string }|null}
 */
function truncateField(value, excess) {
  if (typeof value === 'string') {
    return {
      value: truncateString(value, excess),
      note: `text cut to a prefix (${excess} bytes over)`,
    };
  }
  if (Array.isArray(value)) {
    let kept = value.length;
    let bytes = jsonBytes(value);
    const target = bytes - excess;
    while (kept > 0 && bytes > target) {
      kept -= 1;
      bytes = jsonBytes(value.slice(0, kept));
    }
    return {
      value: value.slice(0, kept),
      note: `kept ${kept} of ${value.length} entries`,
    };
  }
  if (value && typeof value === 'object') {
    const [key] = Object.entries(value)
      .filter(([, v]) => typeof v === 'string')
      .map(([k, v]) => [k, Buffer.byteLength(v, 'utf-8')])
      .sort((a, b) => b[1] - a[1])[0] ?? [null];
    if (key === null) return null;
    return {
      value: { ...value, [key]: truncateString(value[key], excess) },
      note: `.${key} cut to a prefix (${excess} bytes over)`,
    };
  }
  return null;
}

/**
 * Truncate the largest fields to fit, rather than refuse: an oversize seed is
 * the operator's real input, and a partial plan that says so beats none.
 *
 * @param {object} envelope
 * @param {{ ceiling?: number }} [opts]
 * @returns {object} unchanged when it fits, else a copy with `truncated[]`.
 */
function capPlanContextEnvelope(envelope, opts = {}) {
  const ceiling = opts.ceiling ?? PLAN_CONTEXT_ENVELOPE_BYTE_CEILING;
  if (jsonBytes(envelope) <= ceiling) return envelope;

  const next = { ...envelope };
  const truncated = [];
  for (let round = 0; round < MAX_TRUNCATION_ROUNDS; round += 1) {
    const total = jsonBytes({ ...next, truncated });
    if (total <= ceiling) break;
    // Over-cut slightly (JSON escaping of marker/note) so the dominant field
    // absorbs the whole excess instead of spilling onto the system prompts.
    const excess = total - ceiling + 128;
    const candidates = Object.entries(next)
      .map(([field, value]) => [field, jsonBytes(value)])
      .sort((a, b) => b[1] - a[1]);
    let applied = false;
    for (const [field, bytes] of candidates) {
      const cut = truncateField(next[field], excess);
      if (cut === null) continue;
      next[field] = cut.value;
      const record = truncated.find((t) => t.field === field);
      if (record) {
        record.keptBytes = jsonBytes(cut.value);
        record.note = cut.note;
      } else {
        truncated.push({
          field,
          originalBytes: bytes,
          keptBytes: jsonBytes(cut.value),
          note: cut.note,
        });
      }
      applied = true;
      break;
    }
    if (!applied) break;
  }
  Logger.warn(
    `[plan-context] the assembled "${envelope?.mode}" envelope was over the ` +
      `${Math.round(ceiling / 1024)} KB planner-context ceiling — truncated ` +
      `${truncated.map((t) => `${t.field} (${t.note})`).join(', ')}. ` +
      "See the envelope's `truncated` field.",
  );
  return { ...next, truncated };
}

/** Shape descriptor only; persist's validator is the gate. */
export const TICKET_SCHEMA_DESCRIPTOR = Object.freeze({
  shape: 'array',
  itemFields: Object.freeze({
    slug: 'string — ^[a-z0-9][a-z0-9-]*$ (hyphen-case, unique per decompose)',
    type: "string — literal 'story' (2-tier hierarchy: Epic → Story only)",
    title: 'string — short descriptive title',
    body: 'string — serialized Story-body markdown (never a JSON object); omit the ## Acceptance / ## Verify sections, persist syncs them in',
    acceptance:
      'string[] — top-level testable criteria; the machine contract, authored here and not in the body',
    verify:
      'string[] — top-level exact commands/test paths with (<tier>); the machine contract, authored here and not in the body',
    labels:
      "string[]? — extra labels to apply; 'type::story' is applied automatically. agent::*, type::*, and persona::* are rejected (runtime-owned or retired axes)",
    depends_on: 'string[]? — sibling Story slugs that block execution',
  }),
  validatedBy:
    'validateAndNormalizeTickets (lib/orchestration/ticket-validator.js) at persist time',
});

export const STORIES_TEMPLATE_FILENAME = 'stories.template.json';

/**
 * Template `changes[]`: the seed-predicted paths as bare strings (persist
 * derives each assumption against the base branch), or one placeholder.
 *
 * @param {{ predictedPaths?: string[] }|null|undefined} complexitySignals
 * @returns {string[]}
 */
function buildTemplateChanges(complexitySignals) {
  const predicted = Array.isArray(complexitySignals?.predictedPaths)
    ? complexitySignals.predictedPaths.filter(
        (p) => typeof p === 'string' && p.length > 0,
      )
    : [];
  return predicted.length === 0 ? ['path/to/file.ext'] : predicted;
}

/**
 * Ready-to-fill `stories.json` template. Uses the structured-object body
 * persist serializes itself, so authors never reverse-engineer the markdown.
 *
 * @param {{ complexitySignals?: object|null }} [opts]
 * @returns {string} Pretty-printed JSON template content.
 */
export function renderStoriesTemplate({ complexitySignals = null } = {}) {
  const template = [
    {
      slug: 'fill-hyphen-case-slug',
      type: 'story',
      title: 'Fill: short descriptive title',
      body: {
        goal: 'Fill: one sentence stating why this Story exists.',
        // A filled example: each line is a commit-boundary stage of the
        // work, never a restated acceptance item.
        slicing:
          '1. Re-anchor the shared constant and its consumers.\n' +
          '2. Move the gate ahead of the first write and arm the refusal.\n' +
          '3. Delete the superseded module, its test and its flag.\n' +
          '4. Regenerate the affected baselines; run the full gate chain.',
        spec:
          'Optional — contract and invariants only: interfaces, status ' +
          'codes, security invariants, and load-bearing constraints with ' +
          'their why. Implementation choices belong to the deliverer unless ' +
          'load-bearing. No per-file behavior paragraphs, no current-state ' +
          'narration. As long as the work needs. ' +
          'Delete this field when acceptance[] carries the whole contract.',
        changes: buildTemplateChanges(complexitySignals),
        non_goals: [],
      },
      acceptance: [
        'Fill: an outcome a PR reviewer can confirm from the diff and the verify output — as many as the capability has, no target and no ceiling',
      ],
      verify: [
        'Fill: exact command or test path — the mechanical check the acceptance item rests on',
      ],
      depends_on: [],
    },
  ];
  return `${JSON.stringify(template, null, 2)}\n`;
}

/**
 * Count enumerated lines (`- `, `* `, `1. `) anywhere — no heading required.
 *
 * @param {string} text
 * @returns {number}
 */
function countEnumeratedItems(text) {
  if (typeof text !== 'string' || text.length === 0) return 0;
  return text
    .split(/\r?\n/)
    .filter((line) => /^\s*(?:[-*]|\d+\.)\s+\S/.test(line)).length;
}

/** Change-request verbs: such a seed stays a Story within Story width. */
const DELTA_VERB_RE =
  /\b(fix(?:es)?|tweak(?:s)?|extend(?:s)?|update(?:s)?|adjust(?:s)?|rename(?:s)?|correct(?:s)?|patch(?:es)?|bug|regression|flaky)\b/i;

/**
 * Advisory scope signal over raw seed text (one capability = one Story).
 * Erring toward `epic` is cheap; `borderline` is a real verdict.
 *
 * @param {{ seedText?: string }} args
 * @returns {{ verdict: 'epic'|'story'|'borderline', reasons: string[], advisory: true, appliedBy: 'cli' }}
 */
export function buildScopeTriageSignal({ seedText = '' } = {}) {
  const advisory = /** @type {const} */ (true);
  const appliedBy = /** @type {const} */ ('cli');
  const text = typeof seedText === 'string' ? seedText : '';
  const listItems = countEnumeratedItems(text);
  const wordCount = text.split(/\s+/).filter(Boolean).length;

  if (listItems >= 3) {
    return {
      verdict: 'epic',
      reasons: [
        `seed enumerates ${listItems} candidate capabilities — a genuine fan-out surface`,
      ],
      advisory,
      appliedBy,
    };
  }
  if (listItems >= 1) {
    return {
      verdict: 'story',
      reasons: [
        `seed enumerates ${listItems} capability item(s) — one coherent change with one reason to exist`,
      ],
      advisory,
      appliedBy,
    };
  }
  if (DELTA_VERB_RE.test(text) && wordCount <= 120) {
    return {
      verdict: 'story',
      reasons: [
        'delta-shaped seed (change-request verb, no capability enumeration) within Story width',
      ],
      advisory,
      appliedBy,
    };
  }
  if (wordCount >= 250) {
    return {
      verdict: 'epic',
      reasons: [
        `broad prose seed (~${wordCount} words) with no enumeration — plausibly multiple independent capabilities`,
      ],
      advisory,
      appliedBy,
    };
  }
  return {
    verdict: 'borderline',
    reasons: [
      'no capability enumeration and no clear delta signal — could be one ambitious Story or a small Epic; the operator (or the --yes Recommended branch) decides',
    ],
    advisory,
    appliedBy,
  };
}

const WEB_LENS_TARGET = 'web';

/**
 * Sample size of matched UI paths: the signal rides the ~2KB `--out` stdout
 * digest; `matchedPathCount` carries the full total.
 */
const UI_MATCHED_PATH_SAMPLE = 5;

/**
 * Union of every `target: "web"` lens's `triggers.filePatterns` — read from
 * the manifest, never re-listed, so there is one glob set to extend.
 *
 * @param {{ audits?: Record<string, object> }} rules
 * @returns {string[]} Deduplicated globs, in manifest order.
 */
function resolveWebFilePatterns(rules) {
  const patterns = new Set();
  for (const entry of Object.values(rules?.audits ?? {})) {
    if (entry?.target !== WEB_LENS_TARGET) continue;
    for (const glob of entry?.triggers?.filePatterns ?? []) {
      if (typeof glob === 'string' && glob !== '') patterns.add(glob);
    }
  }
  return [...patterns];
}

/**
 * Predicted paths on a UI surface. An unreadable manifest is indeterminate and
 * fails OPEN: a spurious offer costs nothing, a missed one defeats it.
 *
 * @param {string[]} predictedPaths
 * @returns {{ matchedPaths: string[], indeterminate: boolean }}
 */
function resolveWebFootprintMatch(predictedPaths) {
  let patterns;
  try {
    patterns = resolveWebFilePatterns(readAuditRulesSync());
  } catch {
    return { matchedPaths: [], indeterminate: true };
  }
  return {
    matchedPaths: predictedPaths.filter((p) =>
      matchesAnyFilePattern(patterns, [p]),
    ),
    indeterminate: false,
  };
}

/**
 * @param {{
 *   detected: boolean,
 *   webSurface: boolean,
 *   indeterminate: boolean,
 *   sample: string[],
 *   count: number,
 * }} facts
 * @returns {string}
 */
function uiSurfaceReason({
  detected,
  webSurface,
  indeterminate,
  sample,
  count,
}) {
  if (!detected) {
    return webSurface
      ? 'no predicted path matches a web lens filePattern — nothing to prototype'
      : 'project has no rendered web surface — nothing to prototype';
  }
  if (indeterminate) {
    return 'web-capable project and the UI-path manifest could not be read — offering /prototype rather than dropping the option';
  }
  const elided = count - sample.length;
  const shown =
    elided > 0 ? `${sample.join(', ')}, +${elided} more` : sample.join(', ');
  return `web-capable project and the predicted footprint touches ${count} UI path(s) (${shown}) — the operator may want /prototype before UI acceptance criteria are authored`;
}

/**
 * Advisory: web-capable project AND a predicted path matches a web lens glob.
 * The planner may mention `/prototype`, never invoke it. Never throws.
 *
 * @param {{
 *   complexitySignals?: object|null,
 *   config?: object,
 *   cwd?: string,
 * }} [args]
 * @returns {{
 *   detected: boolean,
 *   automatic: false,
 *   advisory: true,
 *   webSurface: boolean,
 *   matchedPaths: string[],
 *   matchedPathCount: number,
 *   reasons: string[],
 * }}
 */
function buildUiSurfaceSignal({ complexitySignals, config, cwd } = {}) {
  const predictedPaths = Array.isArray(complexitySignals?.predictedPaths)
    ? complexitySignals.predictedPaths.filter((p) => typeof p === 'string')
    : [];
  const projectRoot =
    typeof cwd === 'string' && cwd !== '' ? cwd : process.cwd();

  let webSurface;
  try {
    webSurface = hasWebSurface({ config, projectRoot });
  } catch {
    webSurface = true; // indeterminate ⇒ fail open
  }

  const { matchedPaths, indeterminate } =
    resolveWebFootprintMatch(predictedPaths);
  const detected = webSurface && (indeterminate || matchedPaths.length > 0);
  const sample = matchedPaths.slice(0, UI_MATCHED_PATH_SAMPLE);

  return {
    detected,
    automatic: /** @type {const} */ (false),
    advisory: /** @type {const} */ (true),
    webSurface,
    matchedPaths: sample,
    matchedPathCount: matchedPaths.length,
    reasons: [
      uiSurfaceReason({
        detected,
        webSurface,
        indeterminate,
        sample,
        count: matchedPaths.length,
      }),
    ],
  };
}

/**
 * Nest the advisory signals inside `complexitySignals` so the per-mode
 * top-level envelope key sets stay stable.
 *
 * @param {object} complexitySignals
 * @param {{ config?: object, cwd?: string }} [context]
 * @returns {object} the same signals plus `uiSurface`.
 */
function withAdvisorySignals(complexitySignals, { config, cwd } = {}) {
  return {
    ...complexitySignals,
    uiSurface: buildUiSurfaceSignal({ complexitySignals, config, cwd }),
  };
}

/**
 * `storyTicketsRules` only in tickets mode: a `--seed` run has no source
 * ticket to look for.
 *
 * @param {{ mode?: string }} [args]
 * @returns {{ story: string, storySplitRules: string, storyTicketsRules?: string }}
 */
export function buildSystemPrompts({ mode } = {}) {
  return {
    story: renderStoryAuthorCore(),
    storySplitRules: renderStorySplitRules(),
    ...ticketsModePromptField(mode),
  };
}

/**
 * Open-Story duplicate search; failures degrade to [] (triage, not a gate).
 *
 * @param {{
 *   seed: string,
 *   provider: object,
 *   config: object,
 *   excludeIds?: Iterable<number|string>,
 * }} args
 * @returns {Promise<Array<object>>}
 */
async function searchStoryDuplicates({
  seed,
  provider,
  config,
  excludeIds = [],
}) {
  try {
    return await findSimilarOpenStories({
      seed,
      provider,
      owner: config.github?.owner,
      repo: config.github?.repo,
      excludeIds,
    });
  } catch (err) {
    Logger.warn(
      `[plan-context] duplicate search degraded to no candidates: ${err?.message ?? err}`,
    );
    return [];
  }
}

/**
 * Gather independent envelope inputs concurrently; order-preserving, so the
 * result matches a serial build. `docsContextFiles` is emptied because no
 * plan id exists yet for a digest file — the inline digest replaces it.
 *
 * @param {{
 *   seed: string,
 *   epicTitle: string,
 *   excludeIds?: Iterable<number|string>,
 *   provider: object,
 *   config: object,
 *   settings: object,
 *   cwd?: string,
 * }} args
 * @returns {Promise<{
 *   duplicates: Array<object>,
 *   authoring: object,
 *   epicCandidates: Array<object>,
 *   dependencyCandidates: Array<object>,
 *   docsContext: { mode: 'digest-inline', digest: string }|null,
 * }>}
 */
async function gatherEnvelopeInputs({
  seed,
  epicTitle,
  excludeIds = [],
  predictedPaths = [],
  provider,
  config,
  settings,
  cwd,
}) {
  const paths = settings?.paths ?? {};
  const [
    duplicates,
    authoring,
    inlineDigest,
    epicCandidates,
    dependencyCandidates,
  ] = await concurrentMap(
    [
      () => searchStoryDuplicates({ seed, provider, config, excludeIds }),
      () =>
        buildAuthoringContext(
          0,
          /* provider (unused behind the prefetch seam) */ {},
          { ...settings, docsContextFiles: [] },
          {
            epic: { id: 0, title: epicTitle, body: seed },
            github: config.github ?? null,
            cwd,
          },
        ),
      () =>
        buildDocsDigest({
          docsContextFiles: settings?.docsContextFiles,
          docsRoot: paths.docsRoot,
        }),
      () =>
        findOpenEpicCandidates({
          seed,
          provider,
          owner: config.github?.owner,
          repo: config.github?.repo,
        }),
      () =>
        findDependencyCandidates({
          predictedPaths,
          provider,
          owner: config.github?.owner,
          repo: config.github?.repo,
          excludeIds,
        }),
    ],
    (gather) => gather(),
    { concurrency: FANOUT_CONCURRENCY },
  );

  return {
    duplicates,
    authoring,
    epicCandidates,
    dependencyCandidates,
    docsContext:
      inlineDigest == null
        ? null
        : { mode: 'digest-inline', digest: inlineDigest },
  };
}

/** Seed-file envelope; also the base for seed mode. */
async function buildSeedFileModeEnvelope({
  seedFilePath,
  seedFileContent,
  provider,
  config,
  settings,
  cwd,
  modeLabel = 'seed-file',
}) {
  const content =
    seedFileContent ?? (await readFile(seedFilePath ?? '', 'utf-8'));
  if (typeof content !== 'string' || content.trim().length === 0) {
    throw new Error(
      `[plan-context] seed-file at ${seedFilePath ?? '(inline)'} is empty — nothing to plan from.`,
    );
  }

  // Before the gather: dependency candidates intersect `predictedPaths`.
  const complexitySignals = withAdvisorySignals(
    buildComplexitySignals({ seedText: content, cwd }),
    { config, cwd },
  );

  const {
    duplicates,
    authoring,
    docsContext,
    epicCandidates,
    dependencyCandidates,
  } = await gatherEnvelopeInputs({
    seed: content,
    epicTitle: seedFilePath ?? 'seed',
    predictedPaths: complexitySignals.predictedPaths,
    provider,
    config,
    settings,
    cwd,
  });

  return {
    mode: modeLabel,
    seed: { path: seedFilePath ?? null, content },
    // Advisory only — no routing authority.
    complexitySignals,
    duplicates,
    epicCandidates,
    dependencyCandidates,
    docsContext,
    bddRunner: authoring.bddRunner,
    bddScenarios: authoring.bddScenarios,
    memoryPoolAdvisory: authoring.memoryPoolAdvisory,
    priorFeedback: authoring.priorFeedback,
    ticketSchema: TICKET_SCHEMA_DESCRIPTOR,
    systemPrompts: buildSystemPrompts(),
    planState: null,
    planProfile: 'story-default',
  };
}

/** Seed-mode (chat text) envelope. */
async function buildSeedModeEnvelope({
  seedText,
  provider,
  config,
  settings,
  cwd,
}) {
  if (typeof seedText !== 'string' || seedText.trim().length === 0) {
    throw new Error(
      '[plan-context] --seed requires non-empty seed text — nothing to plan from.',
    );
  }
  const base = await buildSeedFileModeEnvelope({
    seedFilePath: undefined,
    seedFileContent: seedText,
    provider,
    config,
    settings,
    cwd,
    modeLabel: 'seed',
  });
  const { seed: _seed, ...rest } = base;
  return {
    ...rest,
    mode: 'seed',
    seed: { text: seedText, path: null },
  };
}

/**
 * @param {number[]} ticketIds
 * @param {object} provider
 * @returns {Promise<Array<{ id:number, title:string, body:string, labels:string[], url?:string }>>}
 */
async function fetchSourceTickets(ticketIds, provider) {
  if (!provider || typeof provider.getTicket !== 'function') {
    throw new Error(
      '[plan-context] tickets mode requires provider.getTicket()',
    );
  }
  return concurrentMap(
    ticketIds,
    async (id) => {
      const ticket = await provider.getTicket(id);
      if (!ticket) {
        throw new Error(`[plan-context] ticket #${id} not found`);
      }
      return {
        id: Number(ticket.id ?? ticket.number ?? id),
        title: ticket.title ?? '',
        body: ticket.body ?? '',
        labels: Array.isArray(ticket.labels)
          ? ticket.labels
              .map((l) => (typeof l === 'string' ? l : l?.name))
              .filter(Boolean)
          : [],
        url: ticket.html_url ?? ticket.url ?? undefined,
        state: ticket.state ?? undefined,
      };
    },
    { concurrency: FANOUT_CONCURRENCY },
  );
}

/** Dup search excludes the source ids: a ticket is not its own duplicate. */
async function buildTicketsModeEnvelope({
  ticketIds,
  provider,
  config,
  settings,
  cwd,
}) {
  if (!Array.isArray(ticketIds) || ticketIds.length === 0) {
    throw new Error(
      '[plan-context] --tickets requires one or more positive issue ids.',
    );
  }
  const sourceTickets = await fetchSourceTickets(ticketIds, provider);
  const seed = sourceTickets
    .map((t) => `# ${t.title}\n\n${t.body}`)
    .join('\n\n---\n\n');

  const complexitySignals = withAdvisorySignals(
    buildComplexitySignals({ seedText: seed, cwd }),
    { config, cwd },
  );

  const {
    duplicates,
    authoring,
    docsContext,
    epicCandidates,
    dependencyCandidates,
  } = await gatherEnvelopeInputs({
    seed,
    epicTitle: sourceTickets[0]?.title ?? 'tickets',
    excludeIds: ticketIds,
    predictedPaths: complexitySignals.predictedPaths,
    provider,
    config,
    settings,
    cwd,
  });

  return {
    mode: 'tickets',
    sourceTickets,
    seed: { text: seed, path: null },
    complexitySignals,
    duplicates,
    epicCandidates,
    dependencyCandidates,
    docsContext,
    bddRunner: authoring.bddRunner,
    bddScenarios: authoring.bddScenarios,
    memoryPoolAdvisory: authoring.memoryPoolAdvisory,
    priorFeedback: authoring.priorFeedback,
    ticketSchema: TICKET_SCHEMA_DESCRIPTOR,
    systemPrompts: buildSystemPrompts({ mode: 'tickets' }),
    planState: null,
    planProfile:
      ticketIds.length === 1 ? 'story-default' : 'story-from-tickets',
    instruction:
      'Analyze the source ticket(s) and author proper type::story ' +
      'ticket(s) under the default-single split policy. Prefer rewriting ' +
      'the source into one well-formed Story (N=1) unless the split policy ' +
      'applies. Do not open an Epic.',
  };
}

/**
 * Prior Story's acceptance and delivered files; an unparseable body degrades
 * to empty lists, never a throw.
 *
 * @param {string} priorBody
 * @returns {{ priorAcceptance: string[], deliveredFiles: string[] }}
 */
function extractPriorArtifacts(priorBody) {
  let parsed;
  try {
    parsed = parseStoryBody(priorBody).body;
  } catch {
    return { priorAcceptance: [], deliveredFiles: [] };
  }
  const priorAcceptance = Array.isArray(parsed.acceptance)
    ? parsed.acceptance.filter((a) => typeof a === 'string' && a.length > 0)
    : [];
  const deliveredFiles = Array.isArray(parsed.changes)
    ? parsed.changes
        .map((c) => (c && typeof c === 'object' ? c.path : c))
        .filter((p) => typeof p === 'string' && p.length > 0)
    : [];
  return { priorAcceptance, deliveredFiles };
}

/**
 * `--amends` envelope: a delta grounded on the prior Story instead of a
 * from-scratch repo interrogation.
 *
 * @param {{
 *   amendsId: number,
 *   provider: object,
 *   config: object,
 *   settings: object,
 *   cwd?: string,
 * }} args
 * @returns {Promise<object>}
 */
async function buildAmendmentModeEnvelope({
  amendsId,
  provider,
  config,
  settings: _settings,
  cwd,
}) {
  if (!provider || typeof provider.getTicket !== 'function') {
    throw new Error(
      '[plan-context] --amends requires provider.getTicket() to load the prior Story.',
    );
  }
  const prior = await provider.getTicket(amendsId);
  if (!prior) {
    throw new Error(
      `[plan-context] --amends #${amendsId}: prior Story not found — nothing to amend.`,
    );
  }
  const priorBody = typeof prior.body === 'string' ? prior.body : '';
  const { priorAcceptance, deliveredFiles } = extractPriorArtifacts(priorBody);

  // A one-member gather, kept on the same path as the other builders.
  const [duplicates] = await concurrentMap(
    [
      () =>
        searchStoryDuplicates({
          seed: priorBody,
          provider,
          config,
          excludeIds: [amendsId],
        }),
    ],
    (gather) => gather(),
    { concurrency: FANOUT_CONCURRENCY },
  );

  return {
    mode: 'amends',
    amends: {
      id: Number(prior.id ?? prior.number ?? amendsId),
      title: prior.title ?? '',
      priorBody,
      priorAcceptance,
      deliveredFiles,
    },
    seed: { text: priorBody, path: null },
    complexitySignals: withAdvisorySignals(
      buildComplexitySignals({ seedText: priorBody, cwd }),
      { config, cwd },
    ),
    duplicates,
    docsContext: null,
    ticketSchema: TICKET_SCHEMA_DESCRIPTOR,
    systemPrompts: buildSystemPrompts(),
    planState: null,
    planProfile: 'story-amendment',
  };
}

/**
 * Build the planner-context envelope — the one place every mode is capped.
 *
 * @param {{
 *   mode: 'seed-file'|'seed'|'tickets'|'amends',
 *   seedFilePath?: string,
 *   seedFileContent?: string,
 *   seedText?: string,
 *   ticketIds?: number[],
 *   amendsId?: number,
 *   provider: object,
 *   config: object,
 *   settings: object,
 *   cwd?: string,
 * }} args
 * @returns {Promise<object>} the JSON-serialisable envelope.
 */
export async function buildPlanContext({
  mode,
  seedFilePath,
  seedFileContent,
  seedText,
  ticketIds,
  amendsId,
  provider,
  config = {},
  settings = {},
  cwd,
}) {
  return capPlanContextEnvelope(
    await buildPlanContextEnvelope({
      mode,
      seedFilePath,
      seedFileContent,
      seedText,
      ticketIds,
      amendsId,
      provider,
      config,
      settings,
      cwd,
    }),
  );
}

async function buildPlanContextEnvelope({
  mode,
  seedFilePath,
  seedFileContent,
  seedText,
  ticketIds,
  amendsId,
  provider,
  config,
  settings,
  cwd,
}) {
  if (mode === 'amends') {
    return buildAmendmentModeEnvelope({
      amendsId,
      provider,
      config,
      settings,
      cwd,
    });
  }
  if (mode === 'seed-file') {
    if (!seedFilePath && typeof seedFileContent !== 'string') {
      throw new Error(
        '[plan-context] seed-file mode requires --seed-file <path>.',
      );
    }
    return buildSeedFileModeEnvelope({
      seedFilePath,
      seedFileContent,
      provider,
      config,
      settings,
      cwd,
      modeLabel: 'seed-file',
    });
  }
  if (mode === 'seed') {
    return buildSeedModeEnvelope({
      seedText,
      provider,
      config,
      settings,
      cwd,
    });
  }
  if (mode === 'tickets') {
    return buildTicketsModeEnvelope({
      ticketIds,
      provider,
      config,
      settings,
      cwd,
    });
  }
  throw new Error(
    `[plan-context] unknown mode "${mode}" — expected "seed", "seed-file", "tickets", or "amends".`,
  );
}
