// lib/cli/ui/panel-model.js
/**
 * The side panel's view model: which view a header button or card opens,
 * and the Connections view built from `/api/connections`. Pure and
 * import-free, so it runs in the browser and under `node --test`.
 *
 * @module cli/ui/panel-model
 */

const CLOUD_NOTE =
  'Local launches run as these accounts. A cloud environment runs as its routine owner.';

/** The view to show after `requested` is asked for: the open one again closes. */
export function nextPanelView(open, requested) {
  return open === requested ? null : requested;
}

/** The Story id a `story-<id>` view shows, or `null` for any other view. */
export function storyOfView(view) {
  return view?.startsWith('story-') ? Number(view.slice(6)) : null;
}

/**
 * The header buttons' badge, labels and Connections tint.
 *
 * @param {number} offline Offline environment count.
 * @param {object|null} connections A `/api/connections` response.
 */
export function headerView(offline, connections) {
  const { ok } = connectionsView(connections);
  const status = ok ? 'connected' : 'needs attention';
  return {
    badge: offline > 0 ? String(offline) : '',
    environments:
      offline > 0 ? `Environments, ${offline} offline` : 'Environments',
    connections: `Connections: ${status}`,
    ok,
  };
}

/** An Environments card's rows from an `environmentCards` entry. */
export function environmentRows(env) {
  return [
    ['Target', env.target],
    ['Load', env.load],
    ['State', env.online ? 'online' : `offline (${env.reason})`],
    ['Defined in', env.definedIn],
    ['Stories', env.stories.map((id) => `#${id}`).join(', ') || 'none'],
  ];
}

function githubRows(github) {
  return [
    ['Login', github.login ?? 'unavailable', 'connections-github-login'],
    ['Token', github.ok ? `from ${github.source}` : 'not found'],
    ['Status', github.ok ? 'connected' : 'not connected'],
  ];
}

function claudeRows(account) {
  if (!account) {
    return [['Account', 'not signed in', 'connections-claude-account']];
  }
  return [
    ['Account', account.email ?? 'unknown', 'connections-claude-account'],
    ['Org', account.orgName],
    ['Plan', account.subscriptionType],
    ['Login method', account.authMethod],
    ['API provider', account.apiProvider],
  ].filter(([, value]) => value !== undefined);
}

function environmentLine(env) {
  const state = env.online ? 'online' : `offline (${env.reason})`;
  if (!env.routine) return `${env.name}: ${state}`;
  return `${env.name}: ${state}, runs as the routine owner (routine ${env.routine})`;
}

/**
 * The Connections view and the header tint (`ok`).
 *
 * @param {object|null} connections A `/api/connections` response.
 */
export function connectionsView(connections) {
  const github = connections?.github ?? { ok: false, source: null };
  const claude = connections?.claude ?? { ok: false, account: null };
  return {
    ok: Boolean(connections) && github.ok && claude.ok,
    sections: [
      { title: 'GitHub', rows: githubRows(github) },
      { title: 'Claude account', rows: claudeRows(claude.account) },
      {
        title: 'claude CLI',
        rows: [['Status', claude.ok ? 'available' : 'not found']],
      },
    ],
    environments: (connections?.environments ?? []).map(environmentLine),
    note: CLOUD_NOTE,
  };
}
