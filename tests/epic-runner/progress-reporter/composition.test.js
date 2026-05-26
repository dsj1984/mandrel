import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { AGENT_LABELS } from '../../../.agents/scripts/lib/label-constants.js';
import { deriveState } from '../../../.agents/scripts/lib/orchestration/epic-runner/progress-reporter/composition.js';

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
