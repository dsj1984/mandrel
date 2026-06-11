/**
 * story-run-progress-writer — render the per-story progress snapshot.
 *
 * Story #3909 — this module no longer **posts** a `story-run-progress`
 * structured comment. That per-Story comment was the redundant mid-flight
 * progress surface: an Epic run already keeps the operator-facing
 * `epic-run-progress` rollup (one comment on the Epic) plus the
 * `epic-run-state` checkpoint and the lifecycle ledger, and the rollup is
 * rendered from the checkpoint `waves[]` — it never read the per-Story
 * comment. The per-Story comment fired at five phase transitions each and
 * duplicated state already on the labels + ledger, so the comment write was
 * removed.
 *
 * The renderer survives because its `{ body, payload }` output still feeds
 * two non-comment contracts: the `renderedBody` markdown the `/deliver`
 * and `single-story-deliver` CLIs (`story-phase.js`, the inline `story-init.js` prepare step)
 * relay to chat so the operator sees the phase table inline, and the snapshot
 * payload returned in those CLIs' JSON envelopes. `upsertStoryRunProgress`
 * therefore renders-only: it computes the body/payload and (optionally) mirrors
 * a low-severity webhook event, but writes no GitHub comment.
 *
 * Payload shape — per tech spec #902 (kept stable; the CLI envelopes carry it
 * verbatim):
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
 * Canonical 2-tier Story-phase order. The Story-phase snapshot replaces the
 * 4-tier per-Task list when the Story carries inline acceptance (no child
 * Tasks). Each entry tracks `status` + `startedAt` / `endedAt` so the parent
 * `/deliver` aggregator can render a coarse progress bar without
 * walking Task tickets.
 */
export const STORY_PHASE_ORDER = ['init', 'implement', 'validate', 'close'];

const VALID_STORY_PHASE_STATUS = new Set(['pending', 'in-progress', 'done']);

const STORY_PHASE_STATUS_EMOJI = {
  pending: '⏳',
  'in-progress': '🔧',
  done: '✅',
};

/**
 * Build the canonical default `phases[]` array for a freshly-initialized
 * 2-tier Story snapshot. All entries are `pending`; timestamps are null.
 * Exported so call sites (the story-init prepare step, story-phase) and
 * tests can build the same shape without re-implementing it.
 *
 * @returns {Array<{ name: string, status: 'pending', startedAt: null, endedAt: null }>}
 */
export function defaultStoryPhases() {
  return STORY_PHASE_ORDER.map((name) => ({
    name,
    status: 'pending',
    startedAt: null,
    endedAt: null,
  }));
}

/**
 * Normalize one Story-phase row into the canonical schema. Timestamps may be
 * `null` (phase not yet started) or ISO-8601 strings; status is one of
 * pending | in-progress | done.
 *
 * @param {object} phase
 * @returns {object}
 */
function normalizeStoryPhase(phase) {
  if (!phase || typeof phase !== 'object') {
    throw new TypeError('story-run-progress phase rows must be objects');
  }
  const name = String(phase.name ?? '');
  if (!STORY_PHASE_ORDER.includes(name)) {
    throw new RangeError(
      `story-run-progress invalid phase name "${name}"; ` +
        `expected one of: ${STORY_PHASE_ORDER.join(', ')}`,
    );
  }
  const status = String(phase.status ?? 'pending');
  if (!VALID_STORY_PHASE_STATUS.has(status)) {
    throw new RangeError(
      `story-run-progress invalid phase status "${status}" for "${name}"; ` +
        `expected one of: ${[...VALID_STORY_PHASE_STATUS].join(', ')}`,
    );
  }
  return {
    name,
    status,
    startedAt: phase.startedAt == null ? null : String(phase.startedAt),
    endedAt: phase.endedAt == null ? null : String(phase.endedAt),
  };
}

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
  return row;
}

/**
 * Build the markdown body the writer upserts. Pure: no IO, no provider call.
 * Exported so tests can pin the rendered shape without going through the
 * upsert path.
 *
 * Two shapes are supported, selected by whether `input.phases` (2-tier
 * Story-phase snapshot) or `input.tasks` (legacy 4-tier per-Task list) is
 * provided. Callers MUST pass exactly one of the two — passing both is
 * rejected as a contract violation so a mistake at the call site fails
 * loudly rather than silently dropping one shape.
 *
 * @param {{
 *   storyId: number,
 *   branch: string,
 *   phase: string,
 *   tasks?: object[],
 *   phases?: object[],
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

  const hasPhases = Array.isArray(input.phases);
  const hasTasks = Array.isArray(input.tasks);
  if (hasPhases && hasTasks) {
    throw new TypeError(
      'renderStoryRunProgressBody: pass either `phases` (2-tier) or `tasks` ' +
        '(4-tier), not both — the snapshot shape is mutually exclusive.',
    );
  }

  const updatedAt = input.updatedAt ?? new Date().toISOString();

  if (hasPhases) {
    return renderPhasesBody({
      storyId,
      branch,
      phase,
      phases: input.phases,
      updatedAt,
    });
  }
  return renderTasksBody({
    storyId,
    branch,
    phase,
    tasks: input.tasks ?? [],
    updatedAt,
  });
}

/**
 * Render the 4-tier per-Task body. Pure helper for `renderStoryRunProgressBody`.
 */
function renderTasksBody({
  storyId,
  branch,
  phase,
  tasks: rawTasks,
  updatedAt,
}) {
  const tasks = rawTasks.map(normalizeTask);
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
 * Render the 2-tier Story-phase body. Pure helper for
 * `renderStoryRunProgressBody`. Emits a `phases[]` payload whose entries
 * carry `{ name, status, startedAt, endedAt }` for init/implement/validate/close.
 */
function renderPhasesBody({ storyId, branch, phase, phases: raw, updatedAt }) {
  const phases = raw.map(normalizeStoryPhase);
  const payload = {
    kind: STORY_RUN_PROGRESS_TYPE,
    storyId,
    branch,
    phase,
    phases,
    updatedAt,
  };

  const done = phases.filter((p) => p.status === 'done').length;
  const total = phases.length;
  const phaseEmoji = PHASE_EMOJI[phase] ?? '';
  const header = `### 📖 Story #${storyId} — ${phaseEmoji} ${phase} · ${done}/${total} phases done`;
  const tableRows = phases.length
    ? [
        '| Phase | Status | Started | Ended |',
        '| --- | --- | --- | --- |',
        ...phases.map((p) => {
          const emoji = STORY_PHASE_STATUS_EMOJI[p.status] ?? '';
          const started = p.startedAt ?? '—';
          const ended = p.endedAt ?? '—';
          return `| ${p.name} | ${emoji} ${p.status} | ${started} | ${ended} |`;
        }),
      ].join('\n')
    : '_(no phases recorded for this story)_';

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
 * Render the story-run-progress snapshot for one phase transition and return
 * `{ body, payload }` so callers can surface the markdown body to chat and
 * carry the payload in their JSON envelope. Story #3909 — this no longer posts
 * a GitHub comment (the redundant mid-flight progress surface was deleted); it
 * renders only and, when `notify` is supplied, mirrors a low-severity webhook
 * event for operators who wire one up.
 *
 * Two shapes are supported, selected by whether `args.phases` (2-tier
 * Story-phase snapshot) or `args.tasks` (legacy 4-tier per-Task list) is
 * provided. The webhook mirror's `done/total` count is computed from whichever
 * shape is active.
 *
 * @param {{
 *   provider?: import('../../ITicketingProvider.js').ITicketingProvider,
 *   storyId: number,
 *   branch: string,
 *   phase: string,
 *   tasks?: object[],
 *   phases?: object[],
 *   epicId?: number,
 *   updatedAt?: string,
 *   notify?: Function,
 * }} args
 * @returns {Promise<{ body: string, payload: object }>}
 */
export async function upsertStoryRunProgress(args) {
  const { notify, epicId, provider: _provider, ...rest } = args ?? {};
  const { body, payload } = renderStoryRunProgressBody(rest);
  if (typeof notify === 'function') {
    const isPhases = Array.isArray(payload.phases);
    const items = isPhases ? payload.phases : payload.tasks;
    const done = isPhases
      ? items.filter((p) => p.status === 'done').length
      : items.filter((t) => t.state === 'done').length;
    const total = items.length;
    const unit = isPhases ? 'phases' : 'tasks';
    const message = `Story #${payload.storyId} · ${payload.phase} · ${done}/${total} ${unit} done`;
    await Promise.resolve(
      notify(
        payload.storyId,
        {
          severity: 'low',
          message,
          event: STORY_RUN_PROGRESS_TYPE,
          level: 'story',
          epicId,
          phase: payload.phase,
        },
        { skipComment: true },
      ),
    ).catch(() => {});
  }
  return { body, payload };
}
