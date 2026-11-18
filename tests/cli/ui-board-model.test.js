// tests/cli/ui-board-model.test.js — the `mandrel ui` view model places
// Stories where the read model says and derives verdict text from `drops`.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildBoard,
  COLUMNS,
  cardView,
  checksText,
  connectionSummary,
  dropZones,
  environmentCards,
  moveOptions,
  nextTheme,
  UNTRACKED,
  verdictText,
  zoneVerdict,
} from '../../lib/cli/ui/board-model.js';

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
    assert.equal(COLUMNS.length, 6);
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
    assert.deepEqual(ready.unmet, [1], 'a dependency in Done is met');
    const done = board.columns.find((c) => c.id === 'done').cards[0];
    assert.deepEqual(done.pr, {
      number: 60,
      url: 'https://github.com/o/r/pull/60',
      checks: '2/3 passed, 1 failed',
    });
    const card = cardView(
      story(3, 'delivering', { stage: 'check', environment: 'local' }),
    );
    assert.equal(card.stage, 'check');
    assert.equal(card.environment, 'local');
    assert.deepEqual(card.unmet, []);
  });

  it('defaults missing fields', () => {
    const card = cardView({ id: 7 });
    assert.equal(card.title, '');
    assert.equal(card.stage, null);
    assert.equal(card.pr, null);
    assert.deepEqual(card.unmet, []);
  });
});

describe('checksText', () => {
  it('summarises a rollup', () => {
    assert.equal(checksText(null), 'no checks');
    assert.equal(
      checksText({ total: 0, passed: 0, failed: 0, pending: 0 }),
      'no checks',
    );
    assert.equal(
      checksText({ total: 4, passed: 1, failed: 1, pending: 2 }),
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

describe('verdictText', () => {
  it('falls back from detail to reason to a default', () => {
    assert.equal(verdictText(refused('stop', 'closing', '')), 'closing');
    assert.equal(verdictText({ ok: false, action: 'stop' }), 'Refused');
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
    assert.deepEqual(
      dropZones(null),
      COLUMNS.map((c) => c.id),
    );
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

describe('connectionSummary', () => {
  it('reports presence and source, never a value', () => {
    const summary = connectionSummary({
      github: { ok: true, source: 'gh' },
      claude: { ok: true },
      environments: [
        { name: 'local', online: true },
        { name: 'box', online: false, reason: 'claude CLI not found' },
      ],
    });
    assert.equal(summary.ok, true);
    assert.deepEqual(summary.lines, [
      'GitHub token: resolved from gh',
      'claude CLI: available',
      'local: online',
      'box: offline (claude CLI not found)',
    ]);
  });

  it('flags missing pieces and a pending report', () => {
    assert.deepEqual(connectionSummary({}), {
      ok: false,
      lines: ['GitHub token: not found', 'claude CLI: not found'],
    });
    assert.equal(connectionSummary(null).ok, false);
  });
});

describe('nextTheme', () => {
  it('cycles auto, light, dark', () => {
    assert.equal(nextTheme('auto'), 'light');
    assert.equal(nextTheme('light'), 'dark');
    assert.equal(nextTheme('dark'), 'auto');
    assert.equal(nextTheme(undefined), 'light');
    assert.equal(nextTheme('bogus'), 'auto');
  });
});
