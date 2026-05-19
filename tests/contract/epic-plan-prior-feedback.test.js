/**
 * tests/contract/epic-plan-prior-feedback.test.js — Story #2554
 *
 * Contract: `epic-plan-spec.js --emit-context` (via `buildAuthoringContext`)
 * MUST attach a `priorFeedback` key to the planner-context envelope with the
 * canonical `{ frameworkGaps, consumerImprovements, fetchedAt, errors }`
 * shape. The fetcher runs against the configured GitHub owner/repo and
 * tolerates the absence of `gh`/network — every failure mode lands in
 * `errors[]` and never throws.
 *
 * The test stubs the provider (so no GitHub round-trip occurs for the Epic)
 * and exercises the real fetcher path; on a CI/dev box without `gh`
 * configured, the fetcher returns empty arrays and one or more strings in
 * `errors[]` — the shape contract still holds.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { buildAuthoringContext } from '../../.agents/scripts/epic-plan-spec.js';

function makeProvider() {
  return {
    async getEpic(id) {
      return {
        id,
        title: 'Test Epic',
        body: '## Overview\nA short epic body for contract testing.',
        linkedIssues: { prd: null, techSpec: null },
      };
    },
  };
}

describe('epic-plan-spec --emit-context: priorFeedback envelope contract', () => {
  it('attaches priorFeedback with the canonical shape', async () => {
    const provider = makeProvider();
    const ctx = await buildAuthoringContext(
      1,
      provider,
      {},
      {
        github: { owner: 'dsj1984', repo: 'mandrel' },
      },
    );

    assert.ok(
      Object.hasOwn(ctx, 'priorFeedback'),
      'planner-context envelope must include priorFeedback key',
    );
    const pf = ctx.priorFeedback;
    assert.equal(typeof pf, 'object');
    assert.ok(pf, 'priorFeedback must not be null');
    assert.ok(
      Array.isArray(pf.frameworkGaps),
      'priorFeedback.frameworkGaps must be an array',
    );
    assert.ok(
      Array.isArray(pf.consumerImprovements),
      'priorFeedback.consumerImprovements must be an array',
    );
    assert.equal(
      typeof pf.fetchedAt,
      'string',
      'priorFeedback.fetchedAt must be a string',
    );
    assert.ok(
      !Number.isNaN(new Date(pf.fetchedAt).getTime()),
      'priorFeedback.fetchedAt must parse as a valid ISO timestamp',
    );
    assert.ok(
      Array.isArray(pf.errors),
      'priorFeedback.errors must be an array',
    );
    for (const err of pf.errors) {
      assert.equal(
        typeof err,
        'string',
        'priorFeedback.errors entries must be strings',
      );
    }
  });

  it('emits empty arrays and a populated errors[] when github config is missing (no throw)', async () => {
    const provider = makeProvider();
    // Omit github → fetcher reports missing-owner/missing-repo into errors[].
    const ctx = await buildAuthoringContext(1, provider, {}, {});

    const pf = ctx.priorFeedback;
    assert.equal(pf.frameworkGaps.length, 0);
    assert.equal(pf.consumerImprovements.length, 0);
    assert.ok(
      pf.errors.length >= 2,
      'missing owner+repo must surface two error strings in priorFeedback.errors',
    );
    assert.match(pf.errors.join('\n'), /owner/);
    assert.match(pf.errors.join('\n'), /repo/);
  });

  it('every returned issue (when present) has a numeric issue number', async () => {
    const provider = makeProvider();
    const ctx = await buildAuthoringContext(
      1,
      provider,
      {},
      {
        github: { owner: 'dsj1984', repo: 'mandrel' },
      },
    );
    const pf = ctx.priorFeedback;
    for (const issue of [...pf.frameworkGaps, ...pf.consumerImprovements]) {
      assert.equal(
        typeof issue.number,
        'number',
        'each prior-feedback issue must carry a numeric `number`',
      );
    }
  });
});
