/**
 * wave-run-progress-writer — render and upsert the per-wave progress comment.
 *
 * `/wave-execute` calls this once per wave, after every Agent-tool sub-agent
 * has returned. The comment is upserted on the Epic ticket (not on each
 * Story) so operators see one in-place snapshot per wave instead of a fresh
 * comment per fire. `/epic-execute`'s rollup and the progress reporter both
 * read these comments to assemble the cross-wave epic-run-progress view.
 *
 * Payload shape — per tech spec #902 (kept stable; consumers parse the JSON
 * fence directly):
 *
 *   {
 *     "kind": "wave-run-progress",
 *     "epicId": <number>,
 *     "wave": <number>,
 *     "concurrencyCap": <number>,
 *     "stories": [
 *       { "id": <n>, "title": "...", "state": "done",
 *         "tasksDone": <n>, "tasksTotal": <n> },
 *       { "id": <n>, "title": "...", "state": "blocked",
 *         "blockerCommentId": "..." }
 *     ],
 *     "updatedAt": "<iso8601>"
 *   }
 */

import { upsertStructuredComment } from '../ticketing.js';

export const WAVE_RUN_PROGRESS_TYPE = 'wave-run-progress';

const VALID_STATES = new Set([
  'done',
  'blocked',
  'failed',
  'in-flight',
  'queued',
  'unknown',
]);

const STATE_EMOJI = {
  done: '✅',
  blocked: '🚧',
  failed: '❌',
  'in-flight': '🔧',
  queued: '⏳',
  unknown: '❓',
};

/**
 * Normalize one Story row into the canonical schema. Drops fields that don't
 * apply to the row's state — `tasksDone/tasksTotal` only make sense for
 * stories that have started; `blockerCommentId` only for blocked rows.
 *
 * @param {object} story
 * @returns {object}
 */
function normalizeStory(story) {
  if (!story || typeof story !== 'object') {
    throw new TypeError('wave-run-progress story rows must be objects');
  }
  const id = Number(story.id ?? story.storyId);
  if (!Number.isInteger(id) || id <= 0) {
    throw new TypeError(
      `wave-run-progress story row missing valid id: ${JSON.stringify(story)}`,
    );
  }
  const state = String(story.state ?? 'unknown');
  if (!VALID_STATES.has(state)) {
    throw new RangeError(
      `wave-run-progress invalid state "${state}" for story #${id}; ` +
        `expected one of: ${[...VALID_STATES].join(', ')}`,
    );
  }
  const row = { id, title: String(story.title ?? ''), state };
  if (Number.isInteger(story.tasksDone))
    row.tasksDone = Number(story.tasksDone);
  if (Number.isInteger(story.tasksTotal))
    row.tasksTotal = Number(story.tasksTotal);
  if (state === 'blocked' && story.blockerCommentId != null) {
    row.blockerCommentId = String(story.blockerCommentId);
  }
  return row;
}

/**
 * Build the markdown body the writer upserts. Pure: no IO, no provider call.
 * Exported so tests can pin the rendered shape without going through the
 * upsert path.
 *
 * @param {{
 *   epicId: number,
 *   wave: number,
 *   concurrencyCap: number,
 *   stories: object[],
 *   updatedAt?: string,
 * }} input
 * @returns {{ body: string, payload: object }}
 */
export function renderWaveRunProgressBody(input) {
  const epicId = Number(input?.epicId);
  const wave = Number(input?.wave);
  const concurrencyCap = Number(input?.concurrencyCap);
  if (!Number.isInteger(epicId) || epicId <= 0) {
    throw new TypeError('renderWaveRunProgressBody requires a numeric epicId');
  }
  if (!Number.isInteger(wave) || wave < 0) {
    throw new TypeError(
      'renderWaveRunProgressBody requires a non-negative integer wave',
    );
  }
  if (!Number.isInteger(concurrencyCap) || concurrencyCap < 1) {
    throw new TypeError(
      'renderWaveRunProgressBody requires a positive concurrencyCap',
    );
  }
  const stories = (input.stories ?? []).map(normalizeStory);
  const updatedAt = input.updatedAt ?? new Date().toISOString();

  const payload = {
    kind: WAVE_RUN_PROGRESS_TYPE,
    epicId,
    wave,
    concurrencyCap,
    stories,
    updatedAt,
  };

  const done = stories.filter((s) => s.state === 'done').length;
  const total = stories.length;
  const header = `### 🌊 Wave ${wave} — ${done}/${total} done · cap ${concurrencyCap}`;
  const tableRows = stories.length
    ? [
        '| ID | State | Title | Tasks |',
        '| --- | --- | --- | --- |',
        ...stories.map((s) => {
          const emoji = STATE_EMOJI[s.state] ?? '';
          const tasks =
            Number.isInteger(s.tasksDone) && Number.isInteger(s.tasksTotal)
              ? `${s.tasksDone}/${s.tasksTotal}`
              : '—';
          const title = String(s.title).replace(/\|/g, '\\|');
          return `| #${s.id} | ${emoji} ${s.state} | ${title} | ${tasks} |`;
        }),
      ].join('\n')
    : '_(no stories assigned to this wave)_';

  const body = [
    header,
    '',
    tableRows,
    '',
    '```json',
    JSON.stringify(payload, null, 2),
    '```',
  ].join('\n');

  return { body, payload };
}

/**
 * Upsert the wave-run-progress structured comment on the Epic. Returns
 * `{ body, payload }` so callers can both return the payload back to
 * `/epic-execute` and surface the rendered markdown body to chat without
 * re-rendering.
 *
 * @param {{
 *   provider: import('../../ITicketingProvider.js').ITicketingProvider,
 *   epicId: number,
 *   wave: number,
 *   concurrencyCap: number,
 *   stories: object[],
 *   updatedAt?: string,
 * }} args
 * @returns {Promise<{ body: string, payload: object }>}
 */
export async function upsertWaveRunProgress(args) {
  const { provider, ...rest } = args ?? {};
  if (!provider || typeof provider.postComment !== 'function') {
    throw new TypeError(
      'upsertWaveRunProgress requires a provider with postComment',
    );
  }
  const { body, payload } = renderWaveRunProgressBody(rest);
  await upsertStructuredComment(
    provider,
    rest.epicId,
    WAVE_RUN_PROGRESS_TYPE,
    body,
  );
  return { body, payload };
}
