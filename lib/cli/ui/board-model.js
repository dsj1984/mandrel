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

/**
 * The fields a card shows.
 *
 * @param {object} story A read-model Story row.
 * @param {Set<number>} openIds
 */
function cardView(story, openIds = new Set()) {
  return {
    id: story.id,
    title: story.title ?? '',
    stage: story.stage ?? null,
    environment: story.environment ?? null,
    pr: story.pr
      ? {
          number: story.pr.number,
          url: story.pr.url,
          checks: checksText(story.pr.checks),
        }
      : null,
    unmet: unmetOf(story, openIds),
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
 * @param {{ environments?: object[], stories?: object[] }} state
 * @param {{ environments?: object[] }|null} [connections]
 */
export function buildBoard(state, connections = null) {
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
  for (const story of stories) {
    const column = byId.get(story.column);
    if (!column) continue;
    const card = cardView(story, openIds);
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
 * The read-only Environments view: one card per environment.
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

/**
 * One line per connection for the Connections dialog and its button.
 *
 * @param {{ github?: { ok: boolean, source: string|null }, claude?: { ok: boolean } }|null} connections
 * @returns {{ ok: boolean, lines: string[] }}
 */
export function connectionSummary(connections) {
  if (!connections) return { ok: false, lines: ['Checking connections…'] };
  const github = connections.github ?? { ok: false, source: null };
  const claude = connections.claude ?? { ok: false };
  const lines = [
    github.ok
      ? `GitHub token: resolved from ${github.source}`
      : 'GitHub token: not found',
    claude.ok ? 'claude CLI: available' : 'claude CLI: not found',
  ];
  for (const env of connections.environments ?? []) {
    lines.push(
      env.online
        ? `${env.name}: online`
        : `${env.name}: offline (${env.reason})`,
    );
  }
  return { ok: github.ok && claude.ok, lines };
}

const THEMES = ['auto', 'light', 'dark'];

/**
 * The theme override after `current` in the auto → light → dark cycle; an
 * unknown value restarts at `auto`.
 *
 * @param {string|null|undefined} current
 * @returns {'auto'|'light'|'dark'}
 */
export function nextTheme(current) {
  const index = THEMES.indexOf(current ?? 'auto');
  return THEMES[(index + 1) % THEMES.length];
}
