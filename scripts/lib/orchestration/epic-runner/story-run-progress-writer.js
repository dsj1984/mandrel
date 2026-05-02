/**
 * story-run-progress-writer — render and upsert the per-story progress comment.
 *
 * `/story-execute` calls this once per Task transition (`pending → executing`,
 * `executing → done|blocked`) and once per phase transition
 * (`init → implementing → closing → done|blocked`). The comment is upserted on
 * the Story ticket (not on the Epic) so the wave aggregator and the
 * epic-runner progress reporter can read each Story's snapshot directly via
 * the structured-comment marker without re-fetching ticket labels or walking
 * the Task tree per Story.
 *
 * Payload shape — per tech spec #902 (kept stable; consumers parse the JSON
 * fence directly):
 *
 *   {
 *     "kind": "story-run-progress",
 *     "storyId": <number>,
 *     "branch": "story-<id>",
 *     "phase": "init|implementing|closing|blocked|done",
 *     "tasks": [
 *       { "id": <n>, "title": "...", "state": "done", "commitSha": "abc1234" },
 *       { "id": <n>, "title": "...", "state": "executing" },
 *       { "id": <n>, "title": "...", "state": "pending" }
 *     ],
 *     "updatedAt": "<iso8601>"
 *   }
 */

import { upsertStructuredComment } from '../ticketing.js';

export const STORY_RUN_PROGRESS_TYPE = 'story-run-progress';

const VALID_TASK_STATES = new Set([
  'pending',
  'executing',
  'done',
  'blocked',
  'failed',
]);

const VALID_PHASES = new Set([
  'init',
  'implementing',
  'closing',
  'blocked',
  'done',
]);

const TASK_STATE_EMOJI = {
  pending: '⏳',
  executing: '🔧',
  done: '✅',
  blocked: '🚧',
  failed: '❌',
};

const PHASE_EMOJI = {
  init: '🌱',
  implementing: '🔧',
  closing: '🔒',
  blocked: '🚧',
  done: '✅',
};

/**
 * Normalize one Task row into the canonical schema. `commitSha` is only
 * carried on `done` rows (it has no meaning before the commit lands and is
 * cleared on rollback).
 *
 * @param {object} task
 * @returns {object}
 */
function normalizeTask(task) {
  if (!task || typeof task !== 'object') {
    throw new TypeError('story-run-progress task rows must be objects');
  }
  const id = Number(task.id ?? task.taskId);
  if (!Number.isInteger(id) || id <= 0) {
    throw new TypeError(
      `story-run-progress task row missing valid id: ${JSON.stringify(task)}`,
    );
  }
  const state = String(task.state ?? 'pending');
  if (!VALID_TASK_STATES.has(state)) {
    throw new RangeError(
      `story-run-progress invalid task state "${state}" for task #${id}; ` +
        `expected one of: ${[...VALID_TASK_STATES].join(', ')}`,
    );
  }
  const row = { id, title: String(task.title ?? ''), state };
  if (state === 'done' && task.commitSha != null) {
    row.commitSha = String(task.commitSha);
  }
  if (state === 'blocked' && task.blockerCommentId != null) {
    row.blockerCommentId = String(task.blockerCommentId);
  }
  return row;
}

/**
 * Build the markdown body the writer upserts. Pure: no IO, no provider call.
 * Exported so tests can pin the rendered shape without going through the
 * upsert path.
 *
 * @param {{
 *   storyId: number,
 *   branch: string,
 *   phase: string,
 *   tasks: object[],
 *   updatedAt?: string,
 * }} input
 * @returns {{ body: string, payload: object }}
 */
export function renderStoryRunProgressBody(input) {
  const storyId = Number(input?.storyId);
  if (!Number.isInteger(storyId) || storyId <= 0) {
    throw new TypeError(
      'renderStoryRunProgressBody requires a numeric storyId',
    );
  }
  const branch = String(input?.branch ?? '');
  if (!branch) {
    throw new TypeError(
      'renderStoryRunProgressBody requires a non-empty branch',
    );
  }
  const phase = String(input?.phase ?? '');
  if (!VALID_PHASES.has(phase)) {
    throw new RangeError(
      `renderStoryRunProgressBody invalid phase "${phase}"; ` +
        `expected one of: ${[...VALID_PHASES].join(', ')}`,
    );
  }
  const tasks = (input.tasks ?? []).map(normalizeTask);
  const updatedAt = input.updatedAt ?? new Date().toISOString();

  const payload = {
    kind: STORY_RUN_PROGRESS_TYPE,
    storyId,
    branch,
    phase,
    tasks,
    updatedAt,
  };

  const done = tasks.filter((t) => t.state === 'done').length;
  const total = tasks.length;
  const phaseEmoji = PHASE_EMOJI[phase] ?? '';
  const header = `### 📖 Story #${storyId} — ${phaseEmoji} ${phase} · ${done}/${total} tasks done`;
  const tableRows = tasks.length
    ? [
        '| ID | State | Title | Commit |',
        '| --- | --- | --- | --- |',
        ...tasks.map((t) => {
          const emoji = TASK_STATE_EMOJI[t.state] ?? '';
          const commit = t.commitSha
            ? `\`${String(t.commitSha).slice(0, 7)}\``
            : '—';
          const title = String(t.title).replace(/\|/g, '\\|');
          return `| #${t.id} | ${emoji} ${t.state} | ${title} | ${commit} |`;
        }),
      ].join('\n')
    : '_(no tasks recorded for this story)_';

  const body = [
    header,
    '',
    `Branch: \`${branch}\``,
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
 * Upsert the story-run-progress structured comment on the Story. Returns
 * `{ body, payload }` so callers can both pass the payload back to
 * `/wave-execute` and surface the rendered markdown body to chat without
 * re-rendering.
 *
 * @param {{
 *   provider: import('../../ITicketingProvider.js').ITicketingProvider,
 *   storyId: number,
 *   branch: string,
 *   phase: string,
 *   tasks: object[],
 *   updatedAt?: string,
 * }} args
 * @returns {Promise<{ body: string, payload: object }>}
 */
export async function upsertStoryRunProgress(args) {
  const { provider, ...rest } = args ?? {};
  if (!provider || typeof provider.postComment !== 'function') {
    throw new TypeError(
      'upsertStoryRunProgress requires a provider with postComment',
    );
  }
  const { body, payload } = renderStoryRunProgressBody(rest);
  await upsertStructuredComment(
    provider,
    rest.storyId,
    STORY_RUN_PROGRESS_TYPE,
    body,
  );
  return { body, payload };
}
