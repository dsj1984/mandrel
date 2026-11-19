// tests/cli/ui-board-model.test.js — the `mandrel ui` view model places
// Stories where the read model says and derives verdict text from `drops`.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildBoard,
  dropZones,
  environmentCards,
  launchOptionsView,
  matchesSearch,
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
      routine: null,
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
      connections: 'Connections: connected, 2 offline',
      ok: true,
    });
    assert.deepEqual(headerView(0, null), {
      badge: '',
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
    assert.deepEqual(
      environmentRows({ online: true, stories: [], routine: 'trig_1' }).at(-1),
      ['Runs as', 'the routine owner (routine trig_1)'],
    );
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
    assert.equal('environments' in view, false, 'environmentCards lists them');
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

describe('AC-9: column counts', () => {
  const countsOf = (board) =>
    Object.fromEntries(board.columns.map((c) => [c.id, c.countText]));

  it('counts the cards each column displays; Done adds its total', () => {
    const board = buildBoard({ ...state(), doneTotal: 345 });
    assert.deepEqual(countsOf(board), {
      backlog: '1',
      planning: '0',
      ready: '1',
      delivering: '3',
      blocked: '1',
      done: '2 of 345',
    });
    assert.equal(board.columns.find((c) => c.id === 'planning').count, 0);
    assert.equal(countsOf(buildBoard(state())).done, '2');
  });

  it('counts only the cards the filters and search leave', () => {
    const board = buildBoard(
      { ...state(), doneTotal: 9 },
      null,
      NOW,
      (s) => s.id !== 6,
    );
    assert.equal(countsOf(board).done, '1 of 9');
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
  });

  it('AC-6: renders no stepper before a stage is published', () => {
    const recorded = statusOf(
      story(3, 'delivering', { stage: null, dispatched: true }),
    );
    assert.equal(recorded.steps, null);
    assert.equal(recorded.stage, 'no stage yet');
    assert.equal(recorded.outside, false);
    const outside = statusOf(story(3, 'delivering', { stage: null }));
    assert.equal(outside.steps, null);
    assert.equal(outside.outside, true, 'no stage and no dispatch record');
    assert.equal(
      statusOf(story(3, 'blocked', { stage: null })).outside,
      false,
      'a Blocked Story is not running',
    );
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
      text: 'Epic #40',
      title: 'Board',
      url: 'https://github.com/o/r/issues/40',
    });
    assert.deepEqual(cardOf(story(2, 'ready', { epic })).epic, {
      text: 'Epic #40',
      title: 'Board',
      url: null,
    });
    assert.equal(cardOf(story(3, 'ready')).epic, null);
    assert.deepEqual(cardOf(story(4, 'ready', { epic: { id: 41 } })).epic, {
      text: 'Epic #41',
      title: null,
      url: null,
    });
    const { facts } = storyDetailView({
      id: 4,
      column: 'ready',
      epic: { id: 41 },
    });
    assert.deepEqual(facts[1], [
      'Epic',
      { links: [{ text: '#41', url: null }] },
    ]);
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

  it('links the card id and its blockers, and colors a drifted Project Status', () => {
    const board = buildBoard({
      environments: [],
      repository: 'o/r',
      stories: [
        story(1, 'ready', {
          dependsOn: [2],
          projectStatus: 'In Progress',
          statusMatches: false,
        }),
        story(2, 'backlog', { projectStatus: 'Triage', statusMatches: false }),
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

describe('launch options (AC-10, AC-11)', () => {
  const state = {
    environments: [
      { name: 'local', target: 'local', model: 'sonnet', effort: null },
      { name: 'gpu', target: 'local', model: null, effort: 'high' },
      { name: 'cloud', target: 'claude-cloud', model: null, effort: null },
    ],
    launchChoices: { models: ['opus', 'sonnet'], efforts: ['low', 'max'] },
  };
  const row = (extra) => ({
    id: 7,
    environment: null,
    overrides: { model: null, effort: null },
    ...extra,
  });

  it('opens each select on "Use default" and preselects the override', () => {
    const view = launchOptionsView(
      row({ overrides: { model: 'opus', effort: null } }),
      state,
    );
    assert.deepEqual(view.model.options, [
      { value: '', text: 'Use default' },
      { value: 'opus', text: 'opus' },
      { value: 'sonnet', text: 'sonnet' },
    ]);
    assert.equal(view.model.value, 'opus');
    assert.equal(view.effort.value, '');
    assert.equal(view.effort.options[0].text, 'Use default');
  });

  it('names the effective value and its source', () => {
    const inLocal = launchOptionsView(
      row({ environment: 'local', overrides: { model: null, effort: 'max' } }),
      state,
    );
    assert.deepEqual(inLocal.effective, [
      'Model: sonnet (from local)',
      'Effort: max (override)',
    ]);
    assert.deepEqual(
      launchOptionsView(row({ environment: 'gpu' }), state).effective,
      ['Model: Claude Code default (from gpu)', 'Effort: high (from gpu)'],
    );
    assert.deepEqual(
      launchOptionsView(
        row({
          environment: 'cloud',
          overrides: { model: 'opus', effort: null },
        }),
        state,
      ).effective,
      ["Model: routine's own model", "Effort: routine's own effort"],
    );
  });

  it('lists each local default for a Story not yet in an environment', () => {
    assert.deepEqual(launchOptionsView(row({}), state).effective, [
      'Model: sonnet (from local) or Claude Code default (from gpu)',
      'Effort: Claude Code default (from local) or high (from gpu)',
    ]);
    const oneLocal = {
      ...state,
      environments: [{ name: 'local', target: 'local', model: null }],
    };
    assert.deepEqual(launchOptionsView(row({}), oneLocal).effective, [
      'Model: Claude Code default (from local)',
      'Effort: Claude Code default (from local)',
    ]);
    const cloudOnly = { ...state, environments: [state.environments[2]] };
    assert.deepEqual(launchOptionsView(row({}), cloudOnly).effective, [
      'Model: set at dispatch',
      'Effort: set at dispatch',
    ]);
  });

  it('renders no model or effort text on the card face', () => {
    const card = cardOf({
      ...story(7, 'ready'),
      overrides: { model: 'opus', effort: 'max' },
    });
    const text = JSON.stringify(card);
    assert.equal(text.includes('opus'), false);
    assert.equal(text.includes('max'), false);
  });

  it('lists Model and Effort facts with their source', () => {
    const facts = (launchOptions, environment = 'local') =>
      Object.fromEntries(
        storyDetailView({
          id: 7,
          column: 'delivering',
          environment,
          launchOptions,
        }).facts,
      );
    const resolved = facts({
      model: { value: 'opus', source: 'override' },
      effort: { value: 'high', source: 'environment' },
    });
    assert.equal(resolved.Model, 'opus (override)');
    assert.equal(resolved.Effort, 'high (from local)');
    const defaults = facts({
      model: { value: null, source: 'claude-default' },
      effort: { value: null, source: 'routine' },
    });
    assert.equal(defaults.Model, 'Claude Code default (from local)');
    assert.equal(defaults.Effort, "routine's own effort");
    assert.match(
      facts({ invalid: 'model::x is not allowed' }).Model,
      /invalid/,
    );
    assert.equal(
      facts({ model: { value: null, source: 'environment' } }, null).Model,
      'set at dispatch',
    );
    assert.equal(facts(null).Model, undefined);
  });
});

describe('AC-1: the card action', () => {
  const actionsOf = (row, env = environments) =>
    buildBoard({ environments: env, stories: [row] })
      .columns.flatMap((c) =>
        c.lanes ? c.lanes.flatMap((l) => l.cards) : c.cards,
      )
      .at(0).actions;

  it('lists every allowed move with its verdict text, first as the button', () => {
    const [ready] = state().stories.filter((s) => s.id === 2);
    assert.deepEqual(
      actionsOf(ready).map((a) => [a.kind, a.text]),
      [['action', 'Dispatch to local']],
    );
    const blocked = state().stories.find((s) => s.id === 5);
    assert.deepEqual(
      actionsOf(blocked).map((a) => a.text),
      ['Stop and return to Ready', 'Resume in box'],
    );
    assert.equal(actionsOf(blocked)[0].kind, 'confirm', 'Stop still confirms');
  });

  it('copies /mandrel-plan for a Backlog Story and offers nothing when no move is allowed', () => {
    assert.deepEqual(
      actionsOf(story(8, 'backlog')).map((a) => [a.kind, a.text]),
      [['copy', '/mandrel-plan 8']],
    );
    assert.deepEqual(actionsOf(story(9, 'done')), []);
  });
});

describe('AC-3: Ready ordering and refusal reasons', () => {
  const refusedEverywhere = (reason, detail) => ({
    local: refused('dispatch', reason, detail),
    box: refused('dispatch', 'at-capacity', 'Environment "box" holds 1 of 1.'),
  });
  const readyCards = () =>
    buildBoard({
      environments,
      stories: [
        story(11, 'ready', {
          drops: refusedEverywhere('foreign-lease', '#11 is leased to @x.'),
        }),
        story(12, 'ready', { drops: { local: ok('dispatch', 'local') } }),
        story(13, 'ready', {
          dependsOn: [12],
          drops: refusedEverywhere('unmet-dependency', 'waits on #12'),
        }),
        story(14, 'ready', { drops: { box: ok('dispatch', 'box') } }),
      ],
    }).columns.find((c) => c.id === 'ready').cards;

  it('lists dispatchable Stories first, each group in read-model order', () => {
    assert.deepEqual(
      readyCards().map((c) => c.id),
      [12, 14, 11, 13],
    );
  });

  it("shows the first refused environment's detail, but no second line for a dependency", () => {
    const byId = Object.fromEntries(readyCards().map((c) => [c.id, c]));
    assert.equal(byId[12].waiting, null);
    assert.deepEqual(byId[11].waiting, { text: '#11 is leased to @x.' });
    assert.deepEqual(byId[13].waiting, { text: null });
    assert.deepEqual(
      byId[13].unmet.map((u) => u.text),
      ['#12'],
    );
  });

  it('marks no card outside Ready as waiting', () => {
    assert.equal(cardOf(story(1, 'backlog')).waiting, null);
  });
});

describe('AC-4: the drift-only Status chip', () => {
  it('shows the chip only when the Status differs from what board-sync writes', () => {
    const onHold = story(1, 'ready', {
      projectStatus: 'On Hold',
      statusMatches: false,
    });
    const todo = story(2, 'ready', {
      projectStatus: 'Todo',
      statusMatches: true,
    });
    assert.deepEqual(cardOf(onHold).projectStatus, {
      text: 'On Hold',
      tone: 'on-hold',
    });
    assert.equal(cardOf(todo).projectStatus, null);
    assert.equal(
      cardOf({ ...todo, statusMatches: null }).projectStatus,
      null,
      'no Status read',
    );
    for (const row of [onHold, todo]) {
      const [status] = storyDetailView(row).facts;
      assert.equal(status[0], 'Status', 'the detail always lists it');
    }
  });
});

describe('AC-5: the blocker line', () => {
  const blocker = {
    text: 'story-handoff blocked: lint',
    url: 'https://github.com/o/r/issues/5#issuecomment-1',
  };

  it('shows a Blocked Story its friction heading, linked in the detail', () => {
    assert.deepEqual(cardOf(story(5, 'blocked', { blocker })).blocker, blocker);
    assert.equal(cardOf(story(5, 'blocked')).blocker, null);
    assert.equal(
      cardOf(story(5, 'delivering', { blocker })).blocker,
      null,
      'only a Blocked card shows it',
    );
    const facts = Object.fromEntries(
      storyDetailView({ id: 5, column: 'blocked', blocker }).facts,
    );
    assert.deepEqual(facts['Blocked by'], { links: [blocker] });
    assert.equal(
      'Blocked by' in
        Object.fromEntries(storyDetailView({ id: 5, column: 'blocked' }).facts),
      false,
    );
  });

  it('drops a URL that is not a GitHub page', () => {
    const view = storyDetailView({
      id: 5,
      column: 'blocked',
      blocker: { text: 'x', url: 'https://example.test/c' },
    });
    assert.deepEqual(Object.fromEntries(view.facts)['Blocked by'], {
      links: [{ text: 'x', url: null }],
    });
  });
});

describe('AC-10: Delivering lanes', () => {
  const delivering = (envs) =>
    buildBoard({
      environments: envs,
      stories: [
        story(4, 'delivering', { environment: null }),
        story(3, 'delivering', { environment: 'local' }),
      ],
    }).columns.find((c) => c.id === 'delivering');

  it('labels the untracked lane and keeps per-environment lanes for two or more', () => {
    const column = delivering(environments);
    assert.deepEqual(
      column.lanes.map((l) => [l.name, l.title]),
      [
        ['local', 'local'],
        ['box', 'box'],
        [UNTRACKED, 'Not launched from the board'],
      ],
    );
    assert.equal(column.header, null);
  });

  it('renders one headless lane for a single environment, launched cards first', () => {
    const column = delivering([environments[0]]);
    assert.equal(column.lanes.length, 1);
    const [lane] = column.lanes;
    assert.equal(lane.name, 'local', 'it stays the environment drop zone');
    assert.equal(lane.title, null);
    assert.deepEqual(
      lane.cards.map((c) => c.id),
      [3, 4],
    );
    assert.equal(column.header, '1/2');
    assert.equal(column.count, 2);
    const offline = buildBoard(
      { environments: [environments[0]], stories: [] },
      { environments: [{ name: 'local', online: false, reason: 'x' }] },
    ).columns.find((c) => c.id === 'delivering');
    assert.equal(offline.header, 'offline');
  });
});

describe('AC-7: matchesSearch', () => {
  const story = { id: 6139, title: 'Dispatch board: one action per card' };

  it('matches every Story on an empty query', () => {
    assert.equal(matchesSearch(story, ''), true);
    assert.equal(matchesSearch(story, '  '), true);
  });

  it('matches digits, with or without #, against the id prefix', () => {
    assert.equal(matchesSearch(story, '613'), true);
    assert.equal(matchesSearch(story, '#6139'), true);
    assert.equal(matchesSearch(story, '139'), false);
  });

  it('matches anything else as a case-insensitive title substring', () => {
    assert.equal(matchesSearch(story, 'ONE ACTION'), true);
    assert.equal(matchesSearch(story, 'epic'), false);
    assert.equal(matchesSearch({ id: 1 }, 'x'), false);
  });
});
