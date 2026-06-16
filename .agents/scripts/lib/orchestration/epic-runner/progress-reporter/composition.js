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
function truncate(s, n) {
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
 * Render and upsert the rolled-up `epic-run-progress` comment on the Epic.
 *
 * Called by `/deliver`'s per-Story status recorder
 * (`epic-execute-record-wave.js`) after each recorder beat. Story #4155
 * (Epic #4151) — the Epic `/deliver` runtime cut over from the wave-batch
 * scheduler to the continuous ready-set core, so the rollup is a **flat
 * per-Story table** keyed by the checkpoint's `stories` status map, not a
 * wave-grouped table. There is no `currentWave` / `totalWaves` / `waves[]`
 * in the payload any more.
 *
 * The payload schema:
 *
 *   {
 *     "kind": "epic-run-progress",
 *     "epicId": <number>,
 *     "stories": [ { id, title?, state, blockerCommentId? } ],
 *     "startedAt"?: "<iso8601>",
 *     "updatedAt": "<iso8601>"
 *   }
 *
 * The function does not re-derive Story state from labels — it trusts the
 * `stories` map supplied by the caller (the checkpoint's recorded per-Story
 * statuses).
 *
 * @param {{
 *   provider: import('../../../ITicketingProvider.js').ITicketingProvider,
 *   epicId: number,
 *   stories: Record<string, { status?: string, title?: string,
 *                             blockerCommentId?: string }>,
 *   startedAt?: string,
 *   now?: () => Date,
 * }} args
 * @returns {Promise<{ body: string, payload: object }>} the rendered body
 *   and payload that were upserted onto the Epic.
 */
export async function upsertEpicRunProgress({
  provider,
  epicId,
  stories,
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
  const statusMap = stories && typeof stories === 'object' ? stories : {};

  const updatedAt = now().toISOString();
  const rows = Object.entries(statusMap)
    .map(([key, rec]) => {
      const id = Number(key);
      const state = String(rec?.status ?? 'pending');
      const row = { id, title: String(rec?.title ?? ''), state };
      if (rec?.blockerCommentId != null) {
        row.blockerCommentId = String(rec.blockerCommentId);
      }
      return row;
    })
    .filter((r) => Number.isInteger(r.id) && r.id > 0)
    .sort((a, b) => a.id - b.id);

  const payload = {
    kind: EPIC_RUN_PROGRESS_TYPE,
    epicId: epicIdNum,
    stories: rows,
    updatedAt,
  };
  if (typeof startedAt === 'string' && startedAt) {
    payload.startedAt = startedAt;
  }

  const totalStories = rows.length;
  const doneStories = rows.filter((s) => s.state === 'done').length;
  const header = `### 📊 Epic Progress — ${doneStories}/${totalStories} stories done`;

  const tableLines = ['| ID | State | Title |', '|---|---|---|'];
  if (rows.length === 0) {
    tableLines.push('| — | _(no stories yet)_ | — |');
  } else {
    for (const s of rows) {
      const emoji = STATE_EMOJI[s.state] ?? '';
      const title = escapePipes(truncate(s.title, 60));
      tableLines.push(`| #${s.id} | ${emoji} ${s.state} | ${title} |`);
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
