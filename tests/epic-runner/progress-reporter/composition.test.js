import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { AGENT_LABELS } from '../../../.agents/scripts/lib/label-constants.js';
import {
  deriveState,
  renderNotable,
} from '../../../.agents/scripts/lib/orchestration/epic-runner/progress-reporter/composition.js';

describe('deriveState', () => {
  const cases = [
    {
      name: 'closed ticket → done (via state)',
      ticket: { state: 'CLOSED', labels: [] },
      expected: 'done',
    },
    {
      name: 'done label → done (even when state is OPEN)',
      ticket: { state: 'OPEN', labels: [AGENT_LABELS.DONE] },
      expected: 'done',
    },
    {
      name: 'blocked label → blocked',
      ticket: { state: 'OPEN', labels: [AGENT_LABELS.BLOCKED] },
      expected: 'blocked',
    },
    {
      name: 'executing label → in-flight',
      ticket: { state: 'OPEN', labels: [AGENT_LABELS.EXECUTING] },
      expected: 'in-flight',
    },
    {
      name: 'ready label → queued',
      ticket: { state: 'OPEN', labels: [AGENT_LABELS.READY] },
      expected: 'queued',
    },
    {
      name: 'no recognised label → unknown',
      ticket: { state: 'OPEN', labels: ['focus::scripts'] },
      expected: 'unknown',
    },
    {
      name: 'null ticket → unknown',
      ticket: null,
      expected: 'unknown',
    },
    {
      name: 'undefined ticket → unknown',
      ticket: undefined,
      expected: 'unknown',
    },
  ];

  for (const { name, ticket, expected } of cases) {
    it(name, () => {
      assert.equal(deriveState(ticket, AGENT_LABELS), expected);
    });
  }

  it('case-folds the state field so "closed" maps to done', () => {
    const ticket = { state: 'closed', labels: [] };
    assert.equal(deriveState(ticket, AGENT_LABELS), 'done');
  });

  it('treats CLOSED state as done even when an EXECUTING label lingers', () => {
    const ticket = {
      state: 'CLOSED',
      labels: [AGENT_LABELS.EXECUTING],
    };
    assert.equal(deriveState(ticket, AGENT_LABELS), 'done');
  });

  it('honours label precedence: BLOCKED beats EXECUTING and READY', () => {
    const ticket = {
      state: 'OPEN',
      labels: [
        AGENT_LABELS.READY,
        AGENT_LABELS.EXECUTING,
        AGENT_LABELS.BLOCKED,
      ],
    };
    assert.equal(deriveState(ticket, AGENT_LABELS), 'blocked');
  });

  it('defaults to unknown when the labels array is missing', () => {
    const ticket = { state: 'OPEN' };
    assert.equal(deriveState(ticket, AGENT_LABELS), 'unknown');
  });
});

describe('renderNotable', () => {
  it('renders "(none)" when no rows match any notable state', async () => {
    const out = await renderNotable({
      rows: [
        { id: 1, state: 'done' },
        { id: 2, state: 'queued' },
      ],
    });
    assert.equal(out, '- (none)');
  });

  it('renders "(none)" for an empty row set', async () => {
    const out = await renderNotable({ rows: [] });
    assert.equal(out, '- (none)');
  });

  it('emits the blocked bullet in isolation (singular form)', async () => {
    const out = await renderNotable({
      rows: [{ id: 42, state: 'blocked' }],
    });
    assert.equal(out, '- 🚧 1 story blocked: #42');
  });

  it('emits the blocked bullet in isolation (plural form)', async () => {
    const out = await renderNotable({
      rows: [
        { id: 1, state: 'blocked' },
        { id: 2, state: 'blocked' },
      ],
    });
    assert.equal(out, '- 🚧 2 stories blocked: #1, #2');
  });

  it('emits the in-flight bullet in isolation', async () => {
    const out = await renderNotable({
      rows: [
        { id: 7, state: 'in-flight' },
        { id: 8, state: 'in-flight' },
      ],
    });
    assert.equal(out, '- 🔧 2 in flight: #7, #8');
  });

  it('emits the unknown bullet in isolation', async () => {
    const out = await renderNotable({
      rows: [{ id: 99, state: 'unknown' }],
    });
    assert.equal(out, '- ❓ 1 unreadable (token scope / network?): #99');
  });

  it('emits all three bullets in canonical order for a mixed-state input', async () => {
    const out = await renderNotable({
      rows: [
        { id: 1, state: 'done' },
        { id: 2, state: 'unknown' },
        { id: 3, state: 'in-flight' },
        { id: 4, state: 'blocked' },
        { id: 5, state: 'queued' },
        { id: 6, state: 'blocked' },
      ],
    });
    assert.equal(
      out,
      [
        '- 🚧 2 stories blocked: #4, #6',
        '- 🔧 1 in flight: #3',
        '- ❓ 1 unreadable (token scope / network?): #2',
      ].join('\n'),
    );
  });

  it('handles an all-unknown row set without leaking the other states', async () => {
    const out = await renderNotable({
      rows: [
        { id: 11, state: 'unknown' },
        { id: 12, state: 'unknown' },
        { id: 13, state: 'unknown' },
      ],
    });
    assert.equal(
      out,
      '- ❓ 3 unreadable (token scope / network?): #11, #12, #13',
    );
  });

  it('handles an all-blocked row set without leaking the other states', async () => {
    const out = await renderNotable({
      rows: [
        { id: 21, state: 'blocked' },
        { id: 22, state: 'blocked' },
      ],
    });
    assert.equal(out, '- 🚧 2 stories blocked: #21, #22');
  });

  it('appends detector bullets after state bullets and normalises leading dashes', async () => {
    const detectors = [
      () => ['detector A bullet'],
      () => ['- already-dashed bullet'],
    ];
    const out = await renderNotable({
      rows: [{ id: 1, state: 'blocked' }],
      detectors,
    });
    assert.equal(
      out,
      [
        '- 🚧 1 story blocked: #1',
        '- detector A bullet',
        '- already-dashed bullet',
      ].join('\n'),
    );
  });

  it('traps detector failures via logger.warn and keeps rendering', async () => {
    const warnings = [];
    const logger = { warn: (msg) => warnings.push(msg) };
    const detectors = [
      () => {
        throw new Error('boom');
      },
      () => ['surviving bullet'],
    ];
    const out = await renderNotable({
      rows: [],
      detectors,
      logger,
    });
    assert.equal(out, '- surviving bullet');
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /detector failed: boom/);
  });
});
