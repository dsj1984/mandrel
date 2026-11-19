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
const UNTRACKED_TITLE = 'Not launched from the board';

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

/** Delivering with neither a published stage nor a dispatch record. */
const runsOutside = (story) =>
  !story.stage && !story.dispatched && story.column === 'delivering';

/** The stage text, the stepper (only once a stage is published), and `outside`. */
function stageView(story) {
  const stage = story.stage ?? null;
  return {
    stage: stage ?? 'no stage yet',
    steps: stage ? stepper(stage) : null,
    outside: runsOutside(story),
  };
}

/**
 * The in-flight status row, or `null` for a card that is not in flight. The
 * stepper shows only with a published stage; a delivering Story with neither
 * a stage nor a dispatch record reads as running outside the board.
 */
function statusView(story, now) {
  if (!IN_FLIGHT.has(story.column)) return null;
  return {
    ...stageView(story),
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

/** The Epic a card names, its full title kept for the link's tooltip. */
function epicView(epic, repository) {
  if (!epic) return null;
  return {
    text: `Epic #${epic.id}`,
    title: epic.title ?? null,
    url: issueUrl(repository, epic.id),
  };
}

/** The first refused environment verdict, in board environment order. */
function firstRefusal(story, envNames) {
  return (
    envNames.map((name) => story.drops?.[name]).find((v) => v && !v.ok) ?? null
  );
}

/** Whether any environment would take a Ready Story now. */
const dispatchable = (story, envNames) =>
  envNames.some((name) => story.drops?.[name]?.ok);

/**
 * Why a Ready card waits: `null` when it is dispatchable or not in Ready;
 * else `{ text }`, where an unmet dependency leaves `text` empty because the
 * `waits on` line already says so.
 */
function waitingView(story, envNames) {
  if (story.column !== 'ready' || dispatchable(story, envNames)) return null;
  const refusal = firstRefusal(story, envNames);
  if (!refusal || refusal.reason === 'unmet-dependency') return { text: null };
  return { text: verdictText(refusal) };
}

/** The Project Status chip, only when it differs from what board-sync writes. */
const driftChip = (story) =>
  story.statusMatches === false ? statusChip(story.projectStatus) : null;

/** A Blocked Story's friction heading, linked when its comment URL is known. */
function blockerView(story) {
  if (story.column !== 'blocked' || !story.blocker?.text) return null;
  return { text: story.blocker.text, url: githubUrl(story.blocker.url) };
}

/**
 * The fields a card shows.
 *
 * @param {object} story A read-model Story row.
 * @param {{ openIds: Set<number>, repository?: string|null,
 *   zones: string[], envNames: string[] }} board
 * @param {number} now Epoch milliseconds.
 */
function cardView(story, { openIds, repository, zones, envNames }, now) {
  return {
    id: story.id,
    url: issueUrl(repository, story.id),
    title: story.title ?? '',
    projectStatus: driftChip(story),
    epic: epicView(story.epic, repository),
    stage: story.stage ?? null,
    environment: story.environment ?? null,
    pr: prView(story.pr),
    unmet: unmetOf(story, openIds).map((id) => issueLink(repository, id)),
    status: statusView(story, now),
    actions: moveOptions(story, zones),
    waiting: waitingView(story, envNames),
    blocker: blockerView(story),
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
    title: env.name,
    target: env.target,
    load: env.load,
    capacity: env.capacity,
    online: status.online,
    reason: status.reason,
    header: status.online ? `${env.load}/${env.capacity}` : 'offline',
    cards: [],
  };
}

const UNTRACKED_LANE = Object.freeze({
  name: UNTRACKED,
  title: UNTRACKED_TITLE,
  target: null,
  load: null,
  capacity: null,
  online: true,
  reason: null,
  header: '',
});

/** Ready cards a drop would dispatch now first, each group in read-model order. */
function readyFirst(cards) {
  return [
    ...cards.filter((c) => !c.waiting),
    ...cards.filter((c) => c.waiting),
  ];
}

/**
 * With one environment, Delivering is one headless lane (launched cards
 * first) whose load the column header carries; else every lane as is.
 */
function deliveringLanes(column, lanes, untracked) {
  if (lanes.length !== 1) {
    column.lanes = [...lanes, untracked];
    return;
  }
  const [env] = lanes;
  column.header = env.header;
  column.lanes = [
    { ...env, title: null, cards: [...env.cards, ...untracked.cards] },
  ];
}

const cardCount = (column) =>
  column.lanes
    ? column.lanes.reduce((n, lane) => n + lane.cards.length, 0)
    : column.cards.length;

/** A column header's count; Done adds the total closed when it is known. */
function countText(column, doneTotal) {
  const count = cardCount(column);
  return column.id === 'done' && Number.isInteger(doneTotal)
    ? `${count} of ${doneTotal}`
    : String(count);
}

/** Place each shown Story's card in its column, or its Delivering lane. */
function placeCards(stories, byId, lanes, untracked, board, now) {
  for (const story of stories) {
    const column = byId.get(story.column);
    if (!column) continue;
    const card = cardView(story, board, now);
    if (story.column === 'delivering') {
      (lanes.find((l) => l.name === story.environment) ?? untracked).cards.push(
        card,
      );
    } else {
      column.cards.push(card);
    }
  }
}

/**
 * Columns with their cards and displayed-card `count`; Delivering also
 * carries its lanes: one per environment plus the `untracked` lane, or a
 * single headless lane with the environment's load in `header` when exactly
 * one environment is configured. Ready lists dispatchable cards first.
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
  const untracked = { ...UNTRACKED_LANE, cards: [] };
  const columns = COLUMNS.map((c) => ({
    ...c,
    cards: [],
    lanes: null,
    header: null,
  }));
  const byId = new Map(columns.map((c) => [c.id, c]));
  const board = {
    openIds,
    repository: state?.repository ?? null,
    zones: dropZones(state),
    envNames: lanes.map((l) => l.name),
  };
  placeCards(stories.filter(shows), byId, lanes, untracked, board, now);
  byId.get('ready').cards = readyFirst(byId.get('ready').cards);
  deliveringLanes(byId.get('delivering'), lanes, untracked);
  for (const column of columns) {
    column.count = cardCount(column);
    column.countText = countText(column, state?.doneTotal);
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

/** `<text> (from <env>)`, or `text` alone without an environment. */
const fromEnv = (text, env) => (env ? `${text} (from ${env})` : text);

/** How each launch-option source reads; `kind` is `model` or `effort`. */
const SOURCE_TEXT = {
  override: ({ value }) => `${value} (override)`,
  environment: ({ value, env }) =>
    value ? fromEnv(value, env) : 'set at dispatch',
  'claude-default': ({ env }) => fromEnv('Claude Code default', env),
  routine: ({ kind }) => `routine's own ${kind}`,
};

/**
 * A launch option (`{ value, source }`) as text.
 *
 * @param {{ value: string|null, source: string }|null|undefined} option
 * @param {'model'|'effort'} kind
 * @param {string|null} [environment] The environment that sets the default.
 * @returns {string|null}
 */
function launchOptionText(option, kind, environment = null) {
  const text = SOURCE_TEXT[option?.source];
  return text ? text({ value: option.value, kind, env: environment }) : null;
}

/** The Model or Effort fact; an invalid override label names its problem. */
function launchFact(detail, kind) {
  const options = detail.launchOptions;
  if (options?.invalid) return `invalid override: ${options.invalid}`;
  return launchOptionText(options?.[kind], kind, detail.environment);
}

/**
 * Detail facts with a value: a string, `{ links: [{ text, url }] }`,
 * `{ chips: string[] }`, or `{ chip: { text, tone } }`. A fact with nothing
 * to say is left out.
 */
/** The detail's Blocked by fact: the friction heading, linked to its comment. */
function blockedByFact(blocker) {
  if (!blocker?.text) return null;
  return { links: [{ text: blocker.text, url: githubUrl(blocker.url) }] };
}

function factRows(detail, now, repository) {
  const status = statusChip(detail.projectStatus);
  const labels = listOrNull(detail.labels);
  const rows = [
    ['Status', status && { chip: status }],
    ['Column', detail.column],
    ['Blocked by', blockedByFact(detail.blocker)],
    ['Environment', detail.environment],
    ['Model', launchFact(detail, 'model')],
    ['Effort', launchFact(detail, 'effort')],
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
 * Every allowed move for a Story — the card's action button and its menu,
 * so no action needs a drag.
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
 * The Connections view's Environments section: one card per environment.
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
      routine: detail?.routine ?? null,
      stories: (state.stories ?? [])
        .filter((s) => s.environment === env.name && s.column !== 'done')
        .map((s) => s.id),
    };
  });
}

/**
 * Whether `story` matches the search box: digits (an optional leading `#`)
 * match the id prefix, anything else a case-insensitive title substring.
 *
 * @param {{ id: number, title?: string }} story
 * @param {string} query
 */
export function matchesSearch(story, query) {
  const text = String(query ?? '')
    .trim()
    .toLowerCase();
  const id = text.match(/^#?(\d+)$/)?.[1];
  if (id) return String(story.id).startsWith(id);
  return String(story.title ?? '')
    .toLowerCase()
    .includes(text);
}

/** The option a Story's row resolves to in `env` (`undefined` before one). */
function rowOption(story, kind, env) {
  if (env?.target === 'claude-cloud') return { value: null, source: 'routine' };
  const override = story.overrides?.[kind];
  if (override) return { value: override, source: 'override' };
  if (!env) return { value: null, source: 'environment' };
  const value = env[kind] ?? null;
  return { value, source: value ? 'environment' : 'claude-default' };
}

/**
 * Each local environment's default, for a Story not yet in one:
 * `sonnet (from local) or Claude Code default (from gpu)`.
 */
function localDefaults(environments, kind) {
  return environments
    .filter((e) => e.target !== 'claude-cloud')
    .map((e) => fromEnv(e[kind] ?? 'Claude Code default', e.name))
    .join(' or ');
}

const KIND_LABELS = { model: 'Model', effort: 'Effort' };

function effectiveLine(story, kind, environments) {
  const env = environments.find((e) => e.name === story.environment);
  const option = rowOption(story, kind, env);
  const label = KIND_LABELS[kind];
  const unplaced = !env && option.source === 'environment';
  const text =
    (unplaced && localDefaults(environments, kind)) ||
    launchOptionText(option, kind, env?.name);
  return `${label}: ${text}`;
}

/** A select's options: "Use default" (an empty value, sent as `null`), then each choice. */
const selectOptions = (choices) => [
  { value: '', text: 'Use default' },
  ...(choices ?? []).map((value) => ({ value, text: value })),
];

/**
 * The launch-options dialog for a Story: each select's options and current
 * override (`''` for the default), and a line per field naming the
 * effective value and its source.
 *
 * @param {object} story A read-model Story row.
 * @param {{ environments?: object[], launchChoices?: { models: string[], efforts: string[] } }} state
 */
export function launchOptionsView(story, state) {
  const environments = state?.environments ?? [];
  const choices = state?.launchChoices ?? { models: [], efforts: [] };
  return {
    heading: `Launch options for #${story.id}`,
    model: {
      options: selectOptions(choices.models),
      value: story.overrides?.model ?? '',
    },
    effort: {
      options: selectOptions(choices.efforts),
      value: story.overrides?.effort ?? '',
    },
    effective: ['model', 'effort'].map((kind) =>
      effectiveLine(story, kind, environments),
    ),
  };
}
