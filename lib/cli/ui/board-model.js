// lib/cli/ui/board-model.js
/**
 * The `mandrel ui` view model: pure functions from the dispatch status read
 * model to columns, lanes, cards and drop-zone verdict text. It runs in the
 * browser (served as a module) and under `node --test`, so it imports
 * nothing. It evaluates no dispatch rule: every verdict it shows is one the
 * read model already computed into the Story's `drops`.
 *
 * @module cli/ui/board-model
 */

const COLUMNS = Object.freeze([
  { id: 'backlog', title: 'Backlog' },
  { id: 'planning', title: 'Planning' },
  { id: 'ready', title: 'Ready' },
  { id: 'delivering', title: 'Delivering' },
  { id: 'blocked', title: 'Blocked' },
  { id: 'done', title: 'Done' },
]);

/** The Delivering lane for in-flight Stories that name no environment. */
const UNTRACKED = 'untracked';

/** The published delivery stages, in order. */
const STAGES = Object.freeze(['build', 'check', 'handoff', 'close', 'merge']);

/** A step before, at and after the current stage. */
const STEP_STATES = ['done', 'current', 'todo'];

/** Columns whose cards show the delivery status row. */
const IN_FLIGHT = new Set(['delivering', 'blocked']);

const LIVENESS_TEXT = {
  working: 'working',
  exited: 'process exited',
  unknown: 'unknown',
};

const ACTION_TEXT = {
  dispatch: (env) => `Dispatch to ${env}`,
  resume: (env) => `Resume in ${env}`,
  stop: () => 'Stop and return to Ready',
};

/**
 * @param {{ total: number, passed: number, failed: number, pending: number }|null|undefined} checks
 * @returns {string}
 */
function checksText(checks) {
  if (!checks || checks.total === 0) return 'no checks';
  const parts = [`${checks.passed}/${checks.total} passed`];
  if (checks.failed > 0) parts.push(`${checks.failed} failed`);
  if (checks.pending > 0) parts.push(`${checks.pending} pending`);
  return parts.join(', ');
}

/** `url` when it is a GitHub page, else `null`: no other link is rendered. */
function githubUrl(url) {
  return typeof url === 'string' && url.startsWith('https://github.com/')
    ? url
    : null;
}

/** The GitHub issue page for ticket `id`, or `null` without a repository. */
function issueUrl(repository, id) {
  return repository
    ? githubUrl(`https://github.com/${repository}/issues/${id}`)
    : null;
}

/** `#<id>` linked to its issue. */
const issueLink = (repository, id) => ({
  text: `#${id}`,
  url: issueUrl(repository, id),
});

/**
 * A Project Status as a chip: its text and a tone the page colors by
 * (`todo`, `in-progress`, `on-hold`, `done`, or `other`); `null` for none.
 */
function statusChip(status) {
  if (!status) return null;
  const slug = String(status).toLowerCase().replace(/\s+/g, '-');
  const tone = ['todo', 'in-progress', 'on-hold', 'done'].includes(slug)
    ? slug
    : 'other';
  return { text: status, tone };
}

function prView(pr) {
  if (!pr) return null;
  return {
    number: pr.number,
    url: githubUrl(pr.url),
    checks: checksText(pr.checks),
  };
}

/**
 * Time from `iso` to `now` as `Nm` or `Nh Mm`; `null` when `iso` is not a date.
 *
 * @param {string|null|undefined} iso
 * @param {number} now Epoch milliseconds.
 * @returns {string|null}
 */
function elapsed(iso, now) {
  const ms = now - Date.parse(iso ?? '');
  return Number.isFinite(ms) ? minutesText(Math.floor(ms / 60_000)) : null;
}

function minutesText(minutes) {
  if (minutes < 60) return `${Math.max(0, minutes)}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** Each stage marked `done`, `current` or `todo` against `stage`. */
function stepper(stage) {
  const at = STAGES.indexOf(stage);
  return STAGES.map((name, i) => ({
    name,
    state: STEP_STATES[Math.sign(i - at) + 1],
  }));
}

/**
 * The liveness badge; `warning` flags a process gone while the Story still
 * reads as executing. `unknown` means the board holds no dispatch record
 * for the Story, so it cannot tell whether a process runs.
 *
 * @param {{ state?: string }|null|undefined} proc
 * @param {string|null|undefined} agentState
 */
function livenessView(proc, agentState) {
  const state = LIVENESS_TEXT[proc?.state] ? proc.state : 'unknown';
  return {
    state,
    text: LIVENESS_TEXT[state],
    warning: state === 'exited' && agentState === 'agent::executing',
  };
}

/** The liveness badge, or `null` when it would only say `unknown`. */
function knownLiveness(proc, agentState) {
  const view = livenessView(proc, agentState);
  return view.state === 'unknown' ? null : view;
}

/** `<label> <elapsed><suffix>`, or `null` when `iso` is not a date. */
function since(label, iso, now, suffix = '') {
  const time = elapsed(iso, now);
  return time && `${label} ${time}${suffix}`;
}

/** The in-flight status row, or `null` for a card that is not in flight. */
function statusView(story, now) {
  if (!IN_FLIGHT.has(story.column)) return null;
  return {
    stage: story.stage ?? 'no stage yet',
    steps: stepper(story.stage),
    liveness: knownLiveness(story.process, story.state),
    running: since('running', story.process?.startedAt, now),
    updated: since('updated', story.stageUpdatedAt, now, ' ago'),
  };
}

/**
 * Dependencies still open on the board: named by the Story and present in a
 * column other than Done.
 *
 * @param {{ dependsOn?: number[] }} story
 * @param {Set<number>} openIds
 * @returns {number[]}
 */
function unmetOf(story, openIds) {
  return (story.dependsOn ?? []).filter((id) => openIds.has(id));
}

/** The Epic a card names, linked to its issue when the repository is known. */
function epicView(epic, repository) {
  if (!epic) return null;
  return {
    text: `Epic #${epic.id} · ${epic.title ?? ''}`.trim(),
    url: issueUrl(repository, epic.id),
  };
}

/**
 * The fields a card shows.
 *
 * @param {object} story A read-model Story row.
 * @param {{ openIds: Set<number>, repository?: string|null }} board
 * @param {number} now Epoch milliseconds.
 */
function cardView(story, { openIds, repository }, now) {
  return {
    id: story.id,
    url: issueUrl(repository, story.id),
    title: story.title ?? '',
    projectStatus: statusChip(story.projectStatus),
    epic: epicView(story.epic, repository),
    stage: story.stage ?? null,
    environment: story.environment ?? null,
    pr: prView(story.pr),
    unmet: unmetOf(story, openIds).map((id) => issueLink(repository, id)),
    status: statusView(story, now),
  };
}

/**
 * Online state per environment name from `/api/connections`; an
 * environment the connections report does not name is taken as online.
 */
function onlineMap(connections) {
  const map = new Map();
  for (const env of connections?.environments ?? []) {
    map.set(env.name, { online: env.online, reason: env.reason ?? null });
  }
  return map;
}

function laneOf(env, online) {
  const status = online.get(env.name) ?? { online: true, reason: null };
  return {
    name: env.name,
    target: env.target,
    load: env.load,
    capacity: env.capacity,
    online: status.online,
    reason: status.reason,
    header: status.online ? `${env.load}/${env.capacity}` : 'offline',
    cards: [],
  };
}

/**
 * Columns with their cards; Delivering also carries one lane per
 * environment plus the `untracked` lane.
 *
 * @param {{ environments?: object[], stories?: object[], repository?: string|null }} state
 * @param {{ environments?: object[] }|null} [connections]
 * @param {number} [now] Epoch milliseconds the relative times count to.
 * @param {(story: object) => boolean} [shows] Which Stories get a card;
 *   dependencies still count every Story on the board.
 */
export function buildBoard(
  state,
  connections = null,
  now = Date.now(),
  shows = () => true,
) {
  const stories = state?.stories ?? [];
  const openIds = new Set(
    stories.filter((s) => s.column !== 'done').map((s) => s.id),
  );
  const online = onlineMap(connections);
  const lanes = (state?.environments ?? []).map((e) => laneOf(e, online));
  const untracked = {
    name: UNTRACKED,
    target: null,
    load: null,
    capacity: null,
    online: true,
    reason: null,
    header: '',
    cards: [],
  };
  const columns = COLUMNS.map((c) => ({ ...c, cards: [], lanes: null }));
  const byId = new Map(columns.map((c) => [c.id, c]));
  byId.get('delivering').lanes = [...lanes, untracked];
  const board = { openIds, repository: state?.repository ?? null };
  for (const story of stories.filter(shows)) {
    const column = byId.get(story.column);
    if (!column) continue;
    const card = cardView(story, board, now);
    if (column.lanes) {
      const lane =
        column.lanes.find((l) => l.name === story.environment) ?? untracked;
      lane.cards.push(card);
    } else {
      column.cards.push(card);
    }
  }
  return { columns, offline: lanes.filter((l) => !l.online).length };
}

const stamp = (iso) => `${String(iso).replace('T', ' ').slice(0, 16)} UTC`;

function recordRows(record) {
  if (!record) return [];
  return [
    ['pid', record.pid],
    ['Started', record.startedAt && stamp(record.startedAt)],
    ['Session', record.sessionId],
    ['Session URL', record.sessionUrl],
    ['Command', record.argv?.join(' ')],
  ].filter(([, value]) => value !== null && value !== undefined);
}

function timelineLine(entry, now) {
  return `${entry.stage}: ${stamp(entry.at)} (${elapsed(entry.at, now) ?? '?'} ago)`;
}

/** The process line, or `null` when the board cannot tell. */
function processText(proc, now) {
  const view = knownLiveness(proc, null);
  if (!view) return null;
  const running = since('running', proc?.startedAt, now);
  return running ? `${view.text}, ${running}` : view.text;
}

/** `{ links }` for a non-empty id list, else `null`. */
function linksOf(repository, ids) {
  return ids.length > 0
    ? { links: ids.map((id) => issueLink(repository, id)) }
    : null;
}

const listOrNull = (items) => (items?.length ? items : null);

function epicLink(epic, repository) {
  if (!epic) return null;
  const { url } = issueLink(repository, epic.id);
  return { links: [{ text: `#${epic.id} ${epic.title ?? ''}`.trim(), url }] };
}

/**
 * Detail facts with a value: a string, `{ links: [{ text, url }] }`,
 * `{ chips: string[] }`, or `{ chip: { text, tone } }`. A fact with nothing
 * to say is left out.
 */
function factRows(detail, now, repository) {
  const status = statusChip(detail.projectStatus);
  const labels = listOrNull(detail.labels);
  const rows = [
    ['Status', status && { chip: status }],
    ['Column', detail.column],
    ['Environment', detail.environment],
    ['Stage', detail.stage],
    ['Process', processText(detail.process, now)],
    ['Assignees', listOrNull(detail.assignees)?.join(', ')],
    ['Epic', epicLink(detail.epic, repository)],
    ['Depends on', linksOf(repository, detail.dependsOn ?? [])],
    ['Labels', labels && { chips: labels }],
  ];
  return rows.filter(([, value]) => value !== null && value !== undefined);
}

/**
 * The Story detail view's sections from a `/api/story` response.
 *
 * @param {object} detail
 * @param {number} [now] Epoch milliseconds.
 * @param {string|null} [repository] `owner/repo`, for ticket links.
 */
export function storyDetailView(detail, now = Date.now(), repository = null) {
  return {
    heading: `#${detail.id} ${detail.title ?? ''}`.trim(),
    issueUrl: githubUrl(detail.issueUrl),
    pr: prView(detail.pr),
    facts: factRows(detail, now, repository),
    timeline: (detail.history ?? []).map((entry) => timelineLine(entry, now)),
    record: recordRows(detail.record),
    resumeCommand: detail.resumeCommand ?? null,
    log: (detail.logTail ?? []).join('\n'),
  };
}

/**
 * The text a verdict reads as: what the drop would do, or why not.
 *
 * @param {{ ok: boolean, action: string, environment?: string, reason?: string, detail?: string }} verdict
 * @returns {string}
 */
function verdictText(verdict) {
  if (!verdict.ok) return verdict.detail || verdict.reason || 'Refused';
  return ACTION_TEXT[verdict.action](verdict.environment);
}

/**
 * What dropping `story` on `zone` (a column id or an environment name)
 * would do. `kind` is `action` (run it), `confirm` (ask first, then run),
 * `copy` (copy `text`'s command), `refused` or `none`.
 *
 * @param {object} story A read-model Story row.
 * @param {string} zone
 * @returns {{ kind: string, text: string, action?: string, environment?: string }}
 */
export function zoneVerdict(story, zone) {
  if (zone === story.column || zone === UNTRACKED) {
    return { kind: 'none', text: 'No change' };
  }
  if (zone === 'planning' && story.column === 'backlog') {
    return { kind: 'copy', text: `/mandrel-plan ${story.id}` };
  }
  const verdict = story.drops?.[zone] ?? null;
  if (!verdict) return { kind: 'none', text: 'No action here' };
  if (!verdict.ok) return { kind: 'refused', text: verdictText(verdict) };
  return {
    kind: verdict.action === 'stop' ? 'confirm' : 'action',
    text: verdictText(verdict),
    action: verdict.action,
    environment: verdict.environment,
  };
}

/**
 * Every allowed move for a Story — the Move menu, so no action needs a drag.
 *
 * @param {object} story
 * @param {string[]} zones Column ids and environment names, in board order.
 */
export function moveOptions(story, zones) {
  return zones
    .map((zone) => ({ zone, ...zoneVerdict(story, zone) }))
    .filter((v) => ['action', 'confirm', 'copy'].includes(v.kind));
}

/**
 * Every drop zone in board order: the columns, then each environment lane.
 *
 * @param {{ environments?: object[] }} state
 * @returns {string[]}
 */
export function dropZones(state) {
  return [
    ...COLUMNS.map((c) => c.id),
    ...(state?.environments ?? []).map((e) => e.name),
  ];
}

/**
 * The Environments panel view: one card per environment.
 *
 * @param {{ environments?: object[], stories?: object[] }} state
 * @param {{ environments?: object[] }|null} [connections]
 */
export function environmentCards(state, connections = null) {
  const details = new Map(
    (connections?.environments ?? []).map((e) => [e.name, e]),
  );
  return (state?.environments ?? []).map((env) => {
    const detail = details.get(env.name);
    return {
      name: env.name,
      target: env.target,
      load: `${env.load}/${env.capacity}`,
      online: detail ? detail.online : true,
      reason: detail?.reason ?? null,
      definedIn: detail?.definedIn ?? 'unknown',
      stories: (state.stories ?? [])
        .filter((s) => s.environment === env.name && s.column !== 'done')
        .map((s) => s.id),
    };
  });
}
