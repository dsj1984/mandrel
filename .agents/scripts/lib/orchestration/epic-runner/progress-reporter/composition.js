/**
 * progress-reporter/composition.js — body builders for the
 * `epic-run-progress` structured comment and the periodic ProgressReporter
 * snapshot.
 *
 * Extracted from the parent `progress-reporter.js` so the
 * structured-comment rendering surface is testable independently of the
 * orchestration shell (`ProgressReporter`) and the I/O webhook posters in
 * `transport.js`. Pure functions only — no provider calls, no clock reads
 * beyond the caller-supplied `now()`.
 *
 * `upsertEpicRunProgress` is the canonical body builder + persistence
 * surface for the rolled-up Epic-level table that lands on the Epic
 * ticket after every wave; the ProgressReporter class delegates its
 * per-poll `#render` / `#renderNotable` to the pure renderers below so
 * the same shape is generated either side of the boundary.
 */

import { upsertStructuredComment } from '../../ticketing.js';
import { EPIC_RUN_PROGRESS_TYPE, STATE_EMOJI } from './signals.js';

/**
 * Truncate `s` to at most `n` characters, suffixing with a single ellipsis
 * (`…`) when the string was longer. Returns the empty string for any
 * falsy input so table cells never render `undefined`/`null`.
 */
export function truncate(s, n) {
  if (!s) return '';
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/**
 * Escape pipe characters so a value can be inlined into a markdown table
 * cell without breaking the column separators.
 */
export function escapePipes(s) {
  return String(s).replace(/\|/g, '\\|');
}

/**
 * Render a millisecond duration as a compact human-readable string. Used
 * in the wave-elapsed header to keep the snapshot tight.
 */
export function formatElapsed(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${sec}s`;
  return `${sec}s`;
}

/**
 * Derive the high-level state classification for a single ticket. Reads
 * the canonical `agent::*` label set first, then falls back to the GitHub
 * `state` string for the closed-without-done case. Returns `'unknown'`
 * for any unrecognized shape so the renderer can flag unreadable rows in
 * the Notable section.
 */
export function deriveState(ticket, AGENT_LABELS) {
  if (!ticket) return 'unknown';
  const labels = ticket.labels ?? [];
  const state = (ticket.state ?? '').toString().toUpperCase();
  if (state === 'CLOSED' || labels.includes(AGENT_LABELS.DONE)) return 'done';
  if (labels.includes(AGENT_LABELS.BLOCKED)) return 'blocked';
  if (labels.includes(AGENT_LABELS.EXECUTING)) return 'in-flight';
  if (labels.includes(AGENT_LABELS.READY)) return 'queued';
  return 'unknown';
}

/**
 * Build the markdown table for the per-poll progress snapshot. Switches
 * between a 3-column (ID / State / Title) and a 4-column (Wave / ID /
 * State / Title) form depending on whether any row carries a wave index —
 * the wider form fires when the reporter has a plan set and is rendering
 * every wave instead of just the current one.
 */
export function renderProgressTable(rows) {
  const includeWaveCol = rows.some((r) => Number.isInteger(r.wave));
  if (includeWaveCol) {
    return [
      '| Wave | ID | State | Title |',
      '|---|---|---|---|',
      ...rows.map(
        (r) =>
          `| ${r.wave + 1} | #${r.id} | ${STATE_EMOJI[r.state] ?? ''} ${r.state} | ${escapePipes(r.title)} |`,
      ),
    ].join('\n');
  }
  return [
    '| ID | State | Title |',
    '|---|---|---|',
    ...rows.map(
      (r) =>
        `| #${r.id} | ${STATE_EMOJI[r.state] ?? ''} ${r.state} | ${escapePipes(r.title)} |`,
    ),
  ].join('\n');
}

/**
 * Declarative descriptor table that drives the Notable bullet block. Each
 * descriptor names a row state, the emoji prefix to render, and the
 * `label(count)` function that produces the count-aware human phrase (e.g.
 * "1 story blocked" vs "2 stories blocked"). Iteration order is the
 * canonical render order: blocked → in-flight → unknown, matching the
 * pre-refactor sequential filter walks so output stays byte-identical.
 */
const STATE_NOTABLE_DESCRIPTORS = [
  {
    state: 'blocked',
    emoji: STATE_EMOJI.blocked,
    label: (n) => `${n} stor${n === 1 ? 'y' : 'ies'} blocked`,
  },
  {
    state: 'in-flight',
    emoji: STATE_EMOJI['in-flight'],
    label: (n) => `${n} in flight`,
  },
  {
    state: 'unknown',
    emoji: STATE_EMOJI.unknown,
    label: (n) => `${n} unreadable (token scope / network?)`,
  },
];

/**
 * Single-pass grouping of `rows` keyed by the descriptor states. Returns a
 * Map<state, row[]> so callers can iterate descriptors and look up the
 * matching slice in O(1); states absent from `rows` get an empty array so
 * the renderer can skip them with a single `length` check.
 */
function groupRowsByNotableState(rows) {
  const groups = new Map(STATE_NOTABLE_DESCRIPTORS.map((d) => [d.state, []]));
  for (const r of rows) {
    const bucket = groups.get(r.state);
    if (bucket) bucket.push(r);
  }
  return groups;
}

/**
 * Run a single detector against `rows`/`ctx`, swallowing any thrown or
 * rejected error so one misbehaving detector cannot kill the whole render
 * path. Failures are surfaced via `logger.warn` so operators still see the
 * signal; the bullet array is treated as empty on failure.
 */
async function runDetector(detector, rows, ctx, logger) {
  try {
    const fn = typeof detector === 'function' ? detector : detector?.detect;
    if (typeof fn !== 'function') return [];
    const out = await fn.call(detector, rows, ctx);
    return Array.isArray(out) ? out : [];
  } catch (err) {
    logger?.warn?.(`[ProgressReporter] detector failed: ${err.message}`);
    return [];
  }
}

/**
 * Render the **Notable** bullet block: blocked-story summary, in-flight
 * counts, unreadable rows, plus any detector bullets that were collected
 * from the caller. Detectors receive `(rows, ctx)` and may return either
 * an array of strings or a thenable resolving to one — the caller is
 * responsible for awaiting and trapping detector failures (we trap them
 * here to keep the render path non-fatal).
 *
 * The state-driven bullets are emitted from `STATE_NOTABLE_DESCRIPTORS`
 * via a single grouping pass, which keeps the cyclomatic surface flat as
 * new notable states are added.
 *
 * Returns the rendered block (without the leading `**Notable**` header so
 * the caller can place it inside a larger composition).
 */
export async function renderNotable({ rows, detectors = [], wave, logger }) {
  const items = [];
  const groups = groupRowsByNotableState(rows);
  for (const { state, emoji, label } of STATE_NOTABLE_DESCRIPTORS) {
    const matched = groups.get(state);
    if (!matched.length) continue;
    const ids = matched.map((r) => `#${r.id}`).join(', ');
    items.push(`- ${emoji} ${label(matched.length)}: ${ids}`);
  }

  const ctx = { wave };
  const detectorResults = await Promise.all(
    (detectors ?? []).map((detector) =>
      runDetector(detector, rows, ctx, logger),
    ),
  );
  for (const bullets of detectorResults) {
    for (const b of bullets) items.push(b.startsWith('- ') ? b : `- ${b}`);
  }

  if (!items.length) items.push('- (none)');
  return items.join('\n');
}

/**
 * Compose the full per-poll snapshot body. Pure with respect to the
 * supplied state — the caller passes the resolved `rows`, the plan/wave
 * context, the optional aggregated phase-timings block, and the now()
 * clock; the renderer assembles header + table + Notable + phase-timings.
 */
export async function renderProgressBody({
  rows,
  plan,
  currentWave,
  epicStartedAt,
  now,
  detectors,
  phaseSummariesBlock,
  logger,
}) {
  const done = rows.filter((r) => r.state === 'done').length;
  const total = rows.length;
  const totalWaves = plan?.length ?? currentWave?.totalWaves ?? '?';
  const currentWaveNum = currentWave
    ? currentWave.index + 1
    : (plan?.length ?? '?');
  const waveLabel = `Wave ${currentWaveNum}/${totalWaves}`;
  const elapsedSrc = epicStartedAt ?? currentWave?.startedAt ?? null;
  const elapsed = elapsedSrc
    ? ` · ${formatElapsed(now() - new Date(elapsedSrc))} elapsed`
    : '';

  const header = `### 📊 Progress — ${waveLabel} · ${done}/${total} closed${elapsed}`;
  const table = renderProgressTable(rows);
  const notable = await renderNotable({
    rows,
    detectors,
    wave: currentWave,
    logger,
  });
  const parts = [header, '', table, '', '**Notable**', notable];
  if (phaseSummariesBlock) parts.push('', phaseSummariesBlock);
  return parts.join('\n');
}

/**
 * Render and upsert the rolled-up `epic-run-progress` comment on the Epic.
 *
 * Called by `/epic-deliver` Step 2b (`epic-execute-record-wave.js`) after
 * each wave completes. The caller folds `state.waves[]` from the
 * `epic-run-state` checkpoint into the per-wave rows and persists the
 * unified rollup as a fenced-JSON payload on the Epic ticket via
 * `upsertStructuredComment`. There is no separate per-wave structured
 * comment — `epic-run-progress` is the single operator-facing summary,
 * grouped by wave.
 *
 * The payload schema is pinned by `epic-execute.md` Step 2b / tech spec
 * #902:
 *
 *   {
 *     "kind": "epic-run-progress",
 *     "epicId": <number>,
 *     "currentWave": <number>,
 *     "totalWaves": <number>,
 *     "waves": [ { wave, concurrencyCap?, stories[] } ],
 *     "startedAt"?: "<iso8601>",
 *     "updatedAt": "<iso8601>"
 *   }
 *
 * The function does not re-derive Story state from labels — it trusts the
 * `waves` argument supplied by the caller, which itself is the projection
 * of the validated, verified per-Story rows recorded on the checkpoint.
 *
 * @param {{
 *   provider: import('../../../ITicketingProvider.js').ITicketingProvider,
 *   epicId: number,
 *   waves: Array<{
 *     wave: number,
 *     concurrencyCap?: number,
 *     stories?: Array<{ id: number, title?: string, state?: string,
 *                       tasksDone?: number, tasksTotal?: number,
 *                       blockerCommentId?: string }>,
 *   }>,
 *   currentWave: number,
 *   totalWaves: number,
 *   startedAt?: string,
 *   now?: () => Date,
 * }} args
 * @returns {Promise<{ body: string, payload: object }>} the rendered body
 *   and payload that were upserted onto the Epic.
 */
export async function upsertEpicRunProgress({
  provider,
  epicId,
  waves,
  currentWave,
  totalWaves,
  startedAt,
  now = () => new Date(),
} = {}) {
  if (!provider || typeof provider.postComment !== 'function') {
    throw new TypeError(
      'upsertEpicRunProgress requires a provider with postComment',
    );
  }
  const epicIdNum = Number(epicId);
  if (!Number.isInteger(epicIdNum) || epicIdNum <= 0) {
    throw new TypeError('upsertEpicRunProgress requires a numeric epicId');
  }
  const totalWavesNum = Number(totalWaves);
  if (!Number.isInteger(totalWavesNum) || totalWavesNum < 0) {
    throw new TypeError(
      'upsertEpicRunProgress requires a non-negative integer totalWaves',
    );
  }
  const currentWaveNum = Number(currentWave);
  if (!Number.isInteger(currentWaveNum) || currentWaveNum < 0) {
    throw new TypeError(
      'upsertEpicRunProgress requires a non-negative integer currentWave',
    );
  }
  const wavesArr = Array.isArray(waves) ? waves : [];

  const updatedAt = now().toISOString();
  const normalizedWaves = wavesArr.map((w) => {
    const stories = Array.isArray(w?.stories) ? w.stories : [];
    const out = {
      wave: Number(w?.wave),
      stories,
    };
    if (Number.isInteger(w?.concurrencyCap)) {
      out.concurrencyCap = Number(w.concurrencyCap);
    }
    return out;
  });

  const payload = {
    kind: EPIC_RUN_PROGRESS_TYPE,
    epicId: epicIdNum,
    currentWave: currentWaveNum,
    totalWaves: totalWavesNum,
    waves: normalizedWaves,
    updatedAt,
  };
  if (typeof startedAt === 'string' && startedAt) {
    payload.startedAt = startedAt;
  }

  const totalStories = normalizedWaves.reduce(
    (acc, w) => acc + w.stories.length,
    0,
  );
  const doneStories = normalizedWaves.reduce(
    (acc, w) => acc + w.stories.filter((s) => s?.state === 'done').length,
    0,
  );
  const header = `### 📊 Epic Progress — Wave ${Math.min(currentWaveNum + 1, Math.max(totalWavesNum, 1))}/${totalWavesNum || '?'} · ${doneStories}/${totalStories} stories done`;

  const tableLines = ['| Wave | ID | State | Title |', '|---|---|---|---|'];
  if (normalizedWaves.length === 0) {
    tableLines.push('| — | — | _(no waves yet)_ | — |');
  } else {
    for (const w of normalizedWaves) {
      if (w.stories.length === 0) {
        tableLines.push(`| ${w.wave + 1} | — | _(empty wave)_ | — |`);
        continue;
      }
      for (const s of w.stories) {
        const state = String(s?.state ?? 'unknown');
        const emoji = STATE_EMOJI[state] ?? '';
        const id = Number(s?.id ?? 0);
        const title = escapePipes(truncate(String(s?.title ?? ''), 60));
        tableLines.push(
          `| ${w.wave + 1} | #${id} | ${emoji} ${state} | ${title} |`,
        );
      }
    }
  }

  const body = [
    header,
    '',
    tableLines.join('\n'),
    '',
    '```json',
    JSON.stringify(payload, null, 2),
    '```',
  ].join('\n');

  await upsertStructuredComment(
    provider,
    epicIdNum,
    EPIC_RUN_PROGRESS_TYPE,
    body,
  );

  return { body, payload };
}
