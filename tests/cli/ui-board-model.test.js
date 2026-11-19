// tests/cli/ui-board-model.test.js — the `mandrel ui` view model places
// Stories where the read model says and derives verdict text from `drops`.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildBoard,
  dropZones,
  environmentCards,
  moveOptions,
  storyDetailView,
  zoneVerdict,
} from '../../lib/cli/ui/board-model.js';
import {
  connectionsView,
  environmentRows,
  headerView,
  nextPanelView,
  storyOfView,
} from '../../lib/cli/ui/panel-model.js';
import {
  DEFAULT_PREFERENCES,
  doneHeader,
  loadPreferences,
  savePreferences,
  settingsFields,
  withPreference,
} from '../../lib/cli/ui/preferences.js';

const UNTRACKED = 'untracked';
const COLUMN_IDS = [
  'backlog',
  'planning',
  'ready',
  'delivering',
  'blocked',
  'done',
];

/** The one card buildBoard renders for a lone Story. */
function cardOf(row) {
  return buildBoard({ environments: [], stories: [row] })
    .columns.flatMap((c) =>
      c.lanes ? c.lanes.flatMap((l) => l.cards) : c.cards,
    )
    .at(0);
}

const ok = (action, environment) => ({
  ok: true,
  action,
  environment,
  applyLabel: action === 'dispatch',
});
const refused = (action, reason, detail) => ({
  ok: false,
  action,
  reason,
  detail,
});

const environments = [
  { name: 'local', target: 'local', capacity: 2, load: 1, online: true },
  { name: 'box', target: 'local', capacity: 1, load: 0, online: true },
];

function story(id, column, extra = {}) {
  return {
    id,
    title: `Story ${id}`,
    column,
    state: null,
    environment: null,
    pr: null,
    dependsOn: [],
    drops: {},
    ...extra,
  };
}

const state = () => ({
  environments,
  stories: [
    story(1, 'backlog'),
    story(2, 'ready', {
      dependsOn: [1, 9],
      drops: {
        ready: refused('stop', 'wrong-environment', 'not held'),
        local: ok('dispatch', 'local'),
        box: refused(
          'dispatch',
          'at-capacity',
          'Environment "box" holds 1 of 1.',
        ),
      },
    }),
    story(3, 'delivering', { environment: 'local', stage: 'check' }),
    story(4, 'delivering', { environment: null }),
    story(5, 'blocked', {
      environment: 'box',
      drops: { ready: ok('stop', 'box'), box: ok('resume', 'box') },
    }),
    story(6, 'done', {
      pr: {
        number: 60,
        url: 'https://github.com/o/r/pull/60',
        checks: { total: 3, passed: 2, failed: 1, pending: 0 },
      },
    }),
    story(9, 'done'),
    story(10, 'delivering', { environment: 'gone' }),
  ],
});

describe('buildBoard', () => {
  it('lists the six columns in order', () => {
    const board = buildBoard(state());
    assert.deepEqual(
      board.columns.map((c) => c.title),
      ['Backlog', 'Planning', 'Ready', 'Delivering', 'Blocked', 'Done'],
    );
  });

  it('places each Story in the column the read model names', () => {
    const board = buildBoard(state());
    const ids = (id) =>
      board.columns.find((c) => c.id === id).cards.map((c) => c.id);
    assert.deepEqual(ids('backlog'), [1]);
    assert.deepEqual(ids('ready'), [2]);
    assert.deepEqual(ids('blocked'), [5]);
    assert.deepEqual(ids('done'), [6, 9]);
    assert.deepEqual(ids('planning'), []);
  });

  it('gives Delivering one lane per environment plus untracked', () => {
    const lanes = buildBoard(state()).columns.find(
      (c) => c.id === 'delivering',
    ).lanes;
    assert.deepEqual(
      lanes.map((l) => l.name),
      ['local', 'box', UNTRACKED],
    );
    assert.deepEqual(
      lanes[0].cards.map((c) => c.id),
      [3],
    );
    assert.equal(lanes[0].header, '1/2');
    assert.deepEqual(
      lanes[2].cards.map((c) => c.id),
      [4, 10],
      'no environment label, or an unknown one, lands in untracked',
    );
  });

  it('marks a lane offline from the connections report', () => {
    const board = buildBoard(state(), {
      environments: [
        { name: 'box', online: false, reason: 'claude CLI not found' },
      ],
    });
    const lanes = board.columns.find((c) => c.id === 'delivering').lanes;
    assert.equal(lanes[1].header, 'offline');
    assert.equal(lanes[1].reason, 'claude CLI not found');
    assert.equal(lanes[0].online, true);
    assert.equal(board.offline, 1);
  });

  it('ignores a Story with an unknown column and copes with empty state', () => {
    const board = buildBoard({ stories: [story(1, 'elsewhere')] });
    assert.equal(
      board.columns.reduce((n, c) => n + c.cards.length, 0),
      0,
    );
    assert.equal(buildBoard(null).columns.length, 6);
  });
});

describe('cardView', () => {
  it('shows id, title, stage, PR checks, unmet dependencies and environment', () => {
    const board = buildBoard(state());
    const ready = board.columns.find((c) => c.id === 'ready').cards[0];
    assert.deepEqual(
      ready.unmet.map((u) => u.text),
      ['#1'],
      'a dependency in Done is met',
    );
    const done = board.columns.find((c) => c.id === 'done').cards[0];
    assert.deepEqual(done.pr, {
      number: 60,
      url: 'https://github.com/o/r/pull/60',
      checks: '2/3 passed, 1 failed',
    });
    const card = cardOf(
      story(3, 'delivering', { stage: 'check', environment: 'local' }),
    );
    assert.equal(card.stage, 'check');
    assert.equal(card.environment, 'local');
    assert.deepEqual(card.unmet, []);
  });

  it('defaults missing fields', () => {
    const card = cardOf({ id: 7, column: 'backlog' });
    assert.equal(card.title, '');
    assert.equal(card.stage, null);
    assert.equal(card.pr, null);
    assert.deepEqual(card.unmet, []);
  });
});

describe('check summary', () => {
  it('summarises a rollup', () => {
    const withChecks = (checks) =>
      cardOf(story(1, 'done', { pr: { number: 1, url: 'u', checks } })).pr
        .checks;
    assert.equal(withChecks(null), 'no checks');
    assert.equal(
      withChecks({ total: 0, passed: 0, failed: 0, pending: 0 }),
      'no checks',
    );
    assert.equal(
      withChecks({ total: 4, passed: 1, failed: 1, pending: 2 }),
      '1/4 passed, 1 failed, 2 pending',
    );
  });
});

describe('zoneVerdict', () => {
  const [, ready, , , blocked] = state().stories;

  it('reads an allowed drop from the Story drops', () => {
    assert.deepEqual(zoneVerdict(ready, 'local'), {
      kind: 'action',
      text: 'Dispatch to local',
      action: 'dispatch',
      environment: 'local',
    });
    assert.equal(zoneVerdict(blocked, 'box').text, 'Resume in box');
  });

  it('shows the refusal detail for a refused drop', () => {
    assert.deepEqual(zoneVerdict(ready, 'box'), {
      kind: 'refused',
      text: 'Environment "box" holds 1 of 1.',
    });
  });

  it('asks for confirmation before a stop', () => {
    const verdict = zoneVerdict(blocked, 'ready');
    assert.equal(verdict.kind, 'confirm');
    assert.equal(verdict.action, 'stop');
    assert.equal(verdict.environment, 'box');
    assert.equal(verdict.text, 'Stop and return to Ready');
  });

  it('copies the plan command for Backlog to Planning', () => {
    assert.deepEqual(zoneVerdict(story(1, 'backlog'), 'planning'), {
      kind: 'copy',
      text: '/mandrel-plan 1',
    });
  });

  it('does nothing on its own column, the untracked lane or a null drop', () => {
    assert.equal(zoneVerdict(ready, 'ready').kind, 'none');
    assert.equal(zoneVerdict(ready, UNTRACKED).kind, 'none');
    assert.equal(zoneVerdict(ready, 'done').kind, 'none');
    assert.equal(
      zoneVerdict(story(2, 'ready', { drops: undefined }), 'local').kind,
      'none',
    );
  });

  it('evaluates no rule: a drop the read model allows is allowed', () => {
    const odd = story(8, 'done', { drops: { local: ok('dispatch', 'local') } });
    assert.equal(zoneVerdict(odd, 'local').kind, 'action');
  });
});

describe('refusal text', () => {
  it('falls back from detail to reason to a default', () => {
    const text = (verdict) =>
      zoneVerdict(
        story(1, 'delivering', { drops: { ready: verdict } }),
        'ready',
      ).text;
    assert.equal(text(refused('stop', 'closing', '')), 'closing');
    assert.equal(text({ ok: false, action: 'stop' }), 'Refused');
  });
});

describe('moveOptions and dropZones', () => {
  it('lists only the allowed moves, in board order', () => {
    const s = state();
    const zones = dropZones(s);
    assert.deepEqual(zones, [
      'backlog',
      'planning',
      'ready',
      'delivering',
      'blocked',
      'done',
      'local',
      'box',
    ]);
    assert.deepEqual(
      moveOptions(s.stories[1], zones).map((o) => o.zone),
      ['local'],
    );
    assert.deepEqual(
      moveOptions(s.stories[4], zones).map((o) => [o.zone, o.kind]),
      [
        ['ready', 'confirm'],
        ['box', 'action'],
      ],
    );
    assert.deepEqual(
      moveOptions(s.stories[0], zones).map((o) => o.kind),
      ['copy'],
    );
    assert.deepEqual(dropZones(null), COLUMN_IDS);
  });
});

describe('environmentCards', () => {
  it('shows target, load, online state, definition and held Stories', () => {
    const cards = environmentCards(state(), {
      environments: [
        {
          name: 'local',
          online: true,
          reason: null,
          definedIn: '.agentrc.json',
        },
        {
          name: 'box',
          online: false,
          reason: 'no GitHub token',
          definedIn: '.agentrc.local.json',
        },
      ],
    });
    assert.deepEqual(cards[0], {
      name: 'local',
      target: 'local',
      load: '1/2',
      online: true,
      reason: null,
      definedIn: '.agentrc.json',
      stories: [3],
    });
    assert.equal(cards[1].online, false);
    assert.deepEqual(cards[1].stories, [5]);
  });

  it('defaults to online and unknown without a connections report', () => {
    const [card] = environmentCards(state());
    assert.equal(card.online, true);
    assert.equal(card.definedIn, 'unknown');
    assert.deepEqual(environmentCards(null), []);
    assert.deepEqual(environmentCards({ environments }).at(0).stories, []);
  });
});

describe('AC-5: nextPanelView', () => {
  it('opens a view, closes it when asked again and switches to another', () => {
    assert.equal(nextPanelView(null, 'environments'), 'environments');
    assert.equal(nextPanelView('environments', 'environments'), null);
    assert.equal(nextPanelView('environments', 'connections'), 'connections');
    assert.equal(nextPanelView('connections', 'story-7'), 'story-7');
  });
});

describe('panel view ids and the header', () => {
  it('reads the Story id from a story view only', () => {
    assert.equal(storyOfView('story-42'), 42);
    assert.equal(storyOfView('connections'), null);
    assert.equal(storyOfView(null), null);
  });

  it('AC-7: badges the offline count and labels each button', () => {
    const ok = {
      github: { ok: true, source: 'gh' },
      claude: { ok: true, account: null },
    };
    assert.deepEqual(headerView(2, ok), {
      badge: '2',
      environments: 'Environments, 2 offline',
      connections: 'Connections: connected',
      ok: true,
    });
    assert.deepEqual(headerView(0, null), {
      badge: '',
      environments: 'Environments',
      connections: 'Connections: needs attention',
      ok: false,
    });
  });

  it('AC-7: lists target, load, online state, definition and Stories', () => {
    assert.deepEqual(
      environmentRows({
        target: 'local',
        load: '1/2',
        online: false,
        reason: 'no GitHub token',
        definedIn: '.agentrc.json',
        stories: [3, 5],
      }),
      [
        ['Target', 'local'],
        ['Load', '1/2'],
        ['State', 'offline (no GitHub token)'],
        ['Defined in', '.agentrc.json'],
        ['Stories', '#3, #5'],
      ],
    );
    assert.deepEqual(environmentRows({ online: true, stories: [] }).slice(2), [
      ['State', 'online'],
      ['Defined in', undefined],
      ['Stories', 'none'],
    ]);
  });
});

describe('AC-6: connectionsView', () => {
  const rowsOf = (view, title) =>
    view.sections.find((s) => s.title === title).rows;

  it('shows the GitHub login, the Claude account and the routine owner note', () => {
    const view = connectionsView({
      github: { ok: true, source: 'gh', login: 'octocat' },
      claude: {
        ok: true,
        account: {
          email: 'dev@example.test',
          orgName: 'Org',
          subscriptionType: 'max',
          authMethod: 'claude.ai',
        },
      },
      environments: [
        { name: 'local', online: true, routine: null },
        { name: 'box', online: false, reason: 'claude CLI not found' },
        { name: 'cloud', online: true, routine: 'trig_1' },
      ],
    });
    assert.equal(view.ok, true);
    assert.deepEqual(rowsOf(view, 'GitHub'), [
      ['Login', 'octocat', 'connections-github-login'],
      ['Token', 'from gh'],
      ['Status', 'connected'],
    ]);
    assert.deepEqual(rowsOf(view, 'Claude account'), [
      ['Account', 'dev@example.test', 'connections-claude-account'],
      ['Org', 'Org'],
      ['Plan', 'max'],
      ['Login method', 'claude.ai'],
    ]);
    assert.deepEqual(rowsOf(view, 'claude CLI'), [['Status', 'available']]);
    assert.deepEqual(view.environments, [
      'local: online',
      'box: offline (claude CLI not found)',
      'cloud: online, runs as the routine owner (routine trig_1)',
    ]);
    assert.match(view.note, /cloud environment runs as its routine owner/);
  });

  it('shows a non-first-party API provider and flags missing pieces', () => {
    const provider = connectionsView({
      github: { ok: true, source: 'environment', login: null },
      claude: { ok: true, account: { apiProvider: 'bedrock' } },
    });
    assert.deepEqual(rowsOf(provider, 'Claude account'), [
      ['Account', 'unknown', 'connections-claude-account'],
      ['API provider', 'bedrock'],
    ]);
    assert.equal(rowsOf(provider, 'GitHub')[0][1], 'unavailable');
    const pending = connectionsView(null);
    assert.equal(pending.ok, false);
    assert.deepEqual(rowsOf(pending, 'GitHub').slice(1), [
      ['Token', 'not found'],
      ['Status', 'not connected'],
    ]);
    assert.deepEqual(rowsOf(pending, 'Claude account'), [
      ['Account', 'not signed in', 'connections-claude-account'],
    ]);
    assert.deepEqual(pending.environments, []);
  });
});

/** A Storage stand-in over a Map; `blocked` makes every call throw. */
function memoryStorage(entries = {}, { blocked = false } = {}) {
  const map = new Map(Object.entries(entries));
  const guarded =
    (fn) =>
    (...args) => {
      if (blocked) throw new Error('SecurityError');
      return fn(...args);
    };
  return {
    map,
    getItem: guarded((key) => map.get(key) ?? null),
    setItem: guarded((key, value) => map.set(key, String(value))),
    removeItem: guarded((key) => map.delete(key)),
  };
}

const SETTINGS_KEY = 'mandrel-board-settings';

describe('preferences', () => {
  it('AC-4: a saved choice survives a reload, and Reset restores the defaults', () => {
    const storage = memoryStorage();
    let prefs = loadPreferences(storage);
    assert.deepEqual(prefs, DEFAULT_PREFERENCES);
    prefs = withPreference(prefs, 'theme', 'dark');
    prefs = withPreference(prefs, 'doneLimit', '50');
    prefs = withPreference(prefs, 'refreshSeconds', '60');
    savePreferences(storage, prefs);
    assert.deepEqual(loadPreferences(storage), {
      theme: 'dark',
      doneLimit: 50,
      refreshSeconds: 60,
    });
    savePreferences(storage, { ...DEFAULT_PREFERENCES });
    assert.deepEqual(loadPreferences(storage), {
      theme: 'auto',
      doneLimit: 20,
      refreshSeconds: 15,
    });
  });

  it('AC-5: blocked, missing, malformed or out-of-range storage gives the defaults', () => {
    for (const storage of [
      null,
      memoryStorage({}, { blocked: true }),
      memoryStorage({ [SETTINGS_KEY]: '{not json' }),
      memoryStorage({ [SETTINGS_KEY]: '"dark"' }),
      memoryStorage({ [SETTINGS_KEY]: 'null' }),
      memoryStorage({
        [SETTINGS_KEY]: JSON.stringify({
          theme: 'neon',
          doneLimit: 25,
          refreshSeconds: -1,
        }),
      }),
    ]) {
      assert.deepEqual(loadPreferences(storage), DEFAULT_PREFERENCES);
      assert.doesNotThrow(() => savePreferences(storage, DEFAULT_PREFERENCES));
    }
    const partial = memoryStorage({
      [SETTINGS_KEY]: JSON.stringify({ doneLimit: 100, refreshSeconds: 7 }),
    });
    assert.deepEqual(loadPreferences(partial), {
      ...DEFAULT_PREFERENCES,
      doneLimit: 100,
    });
  });

  it('AC-6: carries a legacy theme over once, then supersedes its key', () => {
    const storage = memoryStorage({ 'mandrel-ui-theme': 'light' });
    assert.equal(loadPreferences(storage).theme, 'light');
    assert.equal(storage.map.has('mandrel-ui-theme'), false);
    assert.equal(JSON.parse(storage.map.get(SETTINGS_KEY)).theme, 'light');
    const saved = memoryStorage({
      'mandrel-ui-theme': 'light',
      [SETTINGS_KEY]: JSON.stringify({ theme: 'dark' }),
    });
    assert.equal(loadPreferences(saved).theme, 'dark', 'Settings win');
    const junk = memoryStorage({ 'mandrel-ui-theme': 'neon' });
    assert.equal(loadPreferences(junk).theme, 'auto');
  });

  it('ignores an unknown preference name', () => {
    assert.deepEqual(
      withPreference(DEFAULT_PREFERENCES, 'colour', 'red'),
      DEFAULT_PREFERENCES,
    );
    assert.equal(
      withPreference(DEFAULT_PREFERENCES, 'doneLimit', '7').doneLimit,
      20,
    );
  });

  it('lists each setting with its fixed choices and its current value', () => {
    const fields = settingsFields({ ...DEFAULT_PREFERENCES, doneLimit: 50 });
    assert.deepEqual(
      fields.map((f) => [f.testId, f.label]),
      [
        ['settings-theme', 'Theme'],
        ['settings-done-limit', 'Done Stories shown'],
        ['settings-refresh', 'Refresh every'],
      ],
    );
    const [theme, done, refresh] = fields;
    assert.equal(theme.value, 'auto');
    assert.equal(done.value, '50');
    assert.deepEqual(
      done.options.map((o) => o.value),
      ['10', '20', '50', '100'],
    );
    assert.deepEqual(
      refresh.options.map((o) => o.text),
      ['15 s', '30 s', '60 s'],
    );
  });
});

describe('AC-7: the Done column header', () => {
  it('shows the count with its total, or alone when the total is unknown', () => {
    assert.equal(
      doneHeader({ doneShown: 20, doneTotal: 345 }),
      'Done · 20 of 345',
    );
    assert.equal(doneHeader({ doneShown: 20, doneTotal: null }), 'Done · 20');
    assert.equal(doneHeader(null), 'Done');
  });
});

const NOW = Date.parse('2026-11-18T02:00:00.000Z');
const minutesAgo = (m) => new Date(NOW - m * 60_000).toISOString();

describe('AC-8: the in-flight status row', () => {
  const statusOf = (row) =>
    buildBoard({ environments: [], stories: [row] }, null, NOW)
      .columns.flatMap((c) =>
        c.lanes ? c.lanes.flatMap((l) => l.cards) : c.cards,
      )
      .at(0).status;

  it('marks the current stage and the ones before it', () => {
    const status = statusOf(story(3, 'delivering', { stage: 'handoff' }));
    assert.deepEqual(status.steps, [
      { name: 'build', state: 'done' },
      { name: 'check', state: 'done' },
      { name: 'handoff', state: 'current' },
      { name: 'close', state: 'todo' },
      { name: 'merge', state: 'todo' },
    ]);
    assert.equal(status.stage, 'handoff');
    const none = statusOf(story(3, 'delivering', { stage: null }));
    assert.ok(none.steps.every((s) => s.state === 'todo'));
    assert.equal(none.stage, 'no stage yet');
  });

  it('shows the running and updated times', () => {
    const status = statusOf(
      story(3, 'delivering', {
        stage: 'check',
        stageUpdatedAt: minutesAgo(4),
        process: { state: 'working', startedAt: minutesAgo(125) },
      }),
    );
    assert.equal(status.running, 'running 2h 5m');
    assert.equal(status.updated, 'updated 4m ago');
    const unknown = statusOf(story(3, 'blocked', { process: null }));
    assert.equal(unknown.running, null);
    assert.equal(unknown.updated, null);
  });

  it('reads each liveness state, and warns when an executing Story lost its process', () => {
    const liveness = (process, state = 'agent::executing') =>
      statusOf(story(3, 'delivering', { state, process })).liveness;
    assert.deepEqual(liveness({ state: 'working' }), {
      state: 'working',
      text: 'working',
      warning: false,
    });
    assert.deepEqual(liveness({ state: 'exited' }), {
      state: 'exited',
      text: 'process exited',
      warning: true,
    });
    assert.equal(
      liveness({ state: 'exited' }, 'agent::blocked').warning,
      false,
    );
    assert.equal(liveness(undefined), null, 'no record: no badge');
    assert.equal(liveness({ state: 'bogus' }), null);
  });

  it('is absent outside Delivering and Blocked', () => {
    assert.equal(statusOf(story(3, 'ready')), null);
    assert.equal(statusOf(story(3, 'done')), null);
  });
});

describe('AC-11: links', () => {
  it('renders only https://github.com/ PR links', () => {
    const card = cardOf(
      story(3, 'done', {
        pr: { number: 1, url: 'javascript:alert(1)', checks: null },
      }),
    );
    assert.equal(card.pr.url, null);
  });
});

describe('AC-9: storyDetailView', () => {
  const detail = (extra = {}) => ({
    id: 7,
    title: 'Ship it',
    column: 'delivering',
    environment: 'local',
    labels: ['type::story', 'agent::executing'],
    issueUrl: 'https://github.com/o/r/issues/7',
    pr: {
      number: 9,
      url: 'https://github.com/o/r/pull/9',
      checks: { total: 2, passed: 2, failed: 0, pending: 0 },
    },
    stage: 'check',
    history: [
      { stage: 'build', at: minutesAgo(30) },
      { stage: 'check', at: minutesAgo(5) },
    ],
    process: { state: 'working', startedAt: minutesAgo(30) },
    record: {
      pid: 42,
      startedAt: '2026-11-18T01:30:00.000Z',
      argv: ['claude', '-p', '/mandrel-deliver 7'],
      sessionId: 's-1',
      sessionUrl: null,
    },
    resumeCommand: 'claude --resume s-1',
    logTail: ['one', 'two'],
    ...extra,
  });

  it('builds every section from the endpoint fields', () => {
    assert.deepEqual(storyDetailView(detail(), NOW), {
      heading: '#7 Ship it',
      issueUrl: 'https://github.com/o/r/issues/7',
      pr: {
        number: 9,
        url: 'https://github.com/o/r/pull/9',
        checks: '2/2 passed',
      },
      facts: [
        ['Column', 'delivering'],
        ['Environment', 'local'],
        ['Stage', 'check'],
        ['Process', 'working, running 30m'],
        ['Labels', { chips: ['type::story', 'agent::executing'] }],
      ],
      timeline: [
        'build: 2026-11-18 01:30 UTC (30m ago)',
        'check: 2026-11-18 01:55 UTC (5m ago)',
      ],
      record: [
        ['pid', 42],
        ['Started', '2026-11-18 01:30 UTC'],
        ['Session', 's-1'],
        ['Command', 'claude -p /mandrel-deliver 7'],
      ],
      resumeCommand: 'claude --resume s-1',
      log: 'one\ntwo',
    });
  });

  it('defaults an empty Story and drops a non-GitHub link', () => {
    const view = storyDetailView(
      {
        id: 8,
        column: 'blocked',
        issueUrl: 'https://evil.example/x',
        pr: null,
        process: { state: 'exited', startedAt: null },
        record: null,
        logTail: [],
      },
      NOW,
    );
    assert.equal(view.heading, '#8');
    assert.equal(view.issueUrl, null);
    assert.equal(view.pr, null);
    assert.deepEqual(view.facts, [
      ['Column', 'blocked'],
      ['Process', 'process exited'],
    ]);
    assert.deepEqual(view.timeline, []);
    assert.deepEqual(view.record, []);
    assert.equal(view.resumeCommand, null);
    assert.equal(view.log, '');
  });
});

describe('Epic on the card and the assignee predicate', () => {
  it('names the Epic on the card, linked when the repository is known', () => {
    const epic = { id: 40, title: 'Board' };
    const linked = buildBoard({
      environments: [],
      repository: 'o/r',
      stories: [story(1, 'ready', { epic })],
    }).columns.find((c) => c.id === 'ready').cards[0];
    assert.deepEqual(linked.epic, {
      text: 'Epic #40 · Board',
      url: 'https://github.com/o/r/issues/40',
    });
    assert.deepEqual(cardOf(story(2, 'ready', { epic })).epic, {
      text: 'Epic #40 · Board',
      url: null,
    });
    assert.equal(cardOf(story(3, 'ready')).epic, null);
  });

  it('places only the Stories the predicate shows, but counts hidden blockers as unmet', () => {
    const board = buildBoard(
      {
        environments: [],
        stories: [story(1, 'ready', { dependsOn: [2] }), story(2, 'backlog')],
      },
      null,
      Date.now(),
      (s) => s.id === 1,
    );
    const cards = board.columns.flatMap((c) => c.cards);
    assert.deepEqual(
      cards.map((c) => c.id),
      [1],
    );
    assert.deepEqual(cards[0].unmet, [{ text: '#2', url: null }]);
  });

  it('lists Status, assignees, the linked Epic and blockers, and label chips', () => {
    const { facts } = storyDetailView(
      {
        id: 1,
        column: 'ready',
        projectStatus: 'On Hold',
        assignees: ['ana', 'bo'],
        epic: { id: 40, title: 'Board' },
        dependsOn: [5, 6],
        labels: ['type::story'],
        process: { state: 'unknown' },
      },
      NOW,
      'o/r',
    );
    const url = (id) => `https://github.com/o/r/issues/${id}`;
    assert.deepEqual(facts, [
      ['Status', { chip: { text: 'On Hold', tone: 'on-hold' } }],
      ['Column', 'ready'],
      ['Assignees', 'ana, bo'],
      ['Epic', { links: [{ text: '#40 Board', url: url(40) }] }],
      [
        'Depends on',
        {
          links: [
            { text: '#5', url: url(5) },
            { text: '#6', url: url(6) },
          ],
        },
      ],
      ['Labels', { chips: ['type::story'] }],
    ]);
  });

  it('links the card id and its blockers, and colors its Project Status', () => {
    const board = buildBoard({
      environments: [],
      repository: 'o/r',
      stories: [
        story(1, 'ready', { dependsOn: [2], projectStatus: 'In Progress' }),
        story(2, 'backlog', { projectStatus: 'Triage' }),
      ],
    });
    const [ready] = board.columns.find((c) => c.id === 'ready').cards;
    const [backlog] = board.columns.find((c) => c.id === 'backlog').cards;
    assert.equal(ready.url, 'https://github.com/o/r/issues/1');
    assert.deepEqual(ready.unmet, [
      { text: '#2', url: 'https://github.com/o/r/issues/2' },
    ]);
    assert.deepEqual(ready.projectStatus, {
      text: 'In Progress',
      tone: 'in-progress',
    });
    assert.deepEqual(backlog.projectStatus, { text: 'Triage', tone: 'other' });
    assert.equal(cardOf(story(3, 'ready')).projectStatus, null);
    assert.equal(cardOf(story(3, 'ready')).url, null);
  });
});
