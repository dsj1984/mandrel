import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  normalizePlanRunLabel,
  resolvePlanRunFromIssues,
} from '../../.agents/scripts/lib/orchestration/resolve-plan-run.js';
import { resolvePlanRunProvider } from '../../.agents/scripts/resolve-plan-run.js';

describe('resolve-plan-run provider construction', () => {
  it('passes the resolved config to createProvider', () => {
    const config = { github: { owner: 'o', repo: 'r' } };
    let received;
    const provider = { listIssuesByLabel() {} };
    const result = resolvePlanRunProvider({
      resolveConfigFn: () => config,
      createProviderFn: (value) => {
        received = value;
        return provider;
      },
    });
    assert.equal(received, config);
    assert.equal(result, provider);
  });
});

describe('plan-run label normalization', () => {
  it('uses the same canonical token as plan persistence', () => {
    assert.equal(normalizePlanRunLabel('My Run'), 'plan-run::my-run');
    assert.equal(normalizePlanRunLabel('plan-run::My Run'), 'plan-run::my-run');
  });

  it('rejects an empty run token', () => {
    assert.throws(() => normalizePlanRunLabel('  '), /non-empty planRunId/);
  });
});

describe('resolvePlanRunFromIssues', () => {
  it('retains closed Stories so resume can mark dependencies complete', () => {
    const envelope = resolvePlanRunFromIssues({
      run: 'resume',
      issues: [
        {
          number: 10,
          state: 'closed',
          title: 'Migration',
          labels: ['type::story', 'agent::done'],
          body: '## Goal\nDone',
        },
        {
          number: 11,
          state: 'open',
          title: 'Consumer',
          labels: ['type::story', 'agent::ready'],
          body: '## Goal\nUse it\n\n---\nblocked by #10',
        },
      ],
    });
    assert.equal(envelope.stories[0].state, 'closed');
    assert.deepEqual(envelope.done, [10]);
    assert.deepEqual(envelope.dag[1], { id: 11, dependsOn: [10] });
  });
});
