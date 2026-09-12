/**
 * tests/plan-critic-conditions.test.js — the pre-mortem dispatch decision
 * (Epic #4474 PR6; narrowed to the external-dependency arm by Story #5312).
 *
 * Story #5312 deleted the consolidation critic and the two pre-mortem triggers
 * that read deleted constants (`maxTickets` and `planning.riskHeuristics`).
 * What survives is the external-dependency probe (Story #4700): a
 * conservative, marker-only scan for artifacts outside the repo the plan
 * depends on — the one deterministic reason to spend a critic spawn.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import * as conditions from '../.agents/scripts/lib/orchestration/plan-critic-conditions.js';

const { evaluateExternalDependencyProbe, evaluatePremortemDispatch } =
  conditions;

describe('pre-mortem external-dependency probe (Story #4700)', () => {
  const ownerRepo = { owner: 'dsj1984', repo: 'mandrel' };

  describe('evaluateExternalDependencyProbe — the marker matchers', () => {
    it('flags a scoped package absent from the repo manifests', () => {
      const result = evaluateExternalDependencyProbe({
        planText: 'Build the UI once @beestera/assets ships.',
        knownPackages: ['mandrel', '@biomejs/biome'],
        ownerRepo,
      });
      assert.equal(result.matched, true);
      assert.match(result.reasons.join(' '), /@beestera\/assets/);
    });

    it('does not flag a scoped package the repo manifests declare', () => {
      const result = evaluateExternalDependencyProbe({
        planText: 'Bump @biomejs/biome to the next minor',
        knownPackages: ['@biomejs/biome'],
        ownerRepo,
      });
      assert.equal(result.matched, false);
    });

    it('ignores bare handles and the operator-handle placeholder', () => {
      const result = evaluateExternalDependencyProbe({
        planText: 'Ping @dsj1984 and @[USERNAME] when done.',
        knownPackages: [],
        ownerRepo,
      });
      assert.equal(result.matched, false);
    });

    it('flags a cross-repo github.com reference outside the configured repo', () => {
      const result = evaluateExternalDependencyProbe({
        planText: 'Mirror the fix from https://github.com/other/repo/pull/1.',
        knownPackages: [],
        ownerRepo,
      });
      assert.equal(result.matched, true);
      assert.match(result.reasons.join(' '), /other\/repo/);
    });

    it('does not flag the configured repo itself', () => {
      const result = evaluateExternalDependencyProbe({
        planText: 'See https://github.com/dsj1984/mandrel/issues/1.',
        knownPackages: [],
        ownerRepo,
      });
      assert.equal(result.matched, false);
    });

    it('stays silent on cross-repo when the owner is unknown', () => {
      const result = evaluateExternalDependencyProbe({
        planText: 'See https://github.com/other/repo.',
        knownPackages: [],
        ownerRepo: null,
      });
      assert.equal(result.matched, false);
    });

    it('flags an endpoint named as a service prerequisite', () => {
      const result = evaluateExternalDependencyProbe({
        planText:
          'Requires credentials for https://api.example.com before delivery.',
        knownPackages: [],
        ownerRepo,
      });
      assert.equal(result.matched, true);
      assert.match(result.reasons.join(' '), /api\.example\.com/);
    });

    it('does not flag a casual documentation URL with no prerequisite keyword', () => {
      const result = evaluateExternalDependencyProbe({
        planText: 'Background reading: https://docs.example.com/guide.',
        knownPackages: [],
        ownerRepo,
      });
      assert.equal(result.matched, false);
    });

    it('returns matched=false with no reasons on empty plan text', () => {
      const result = evaluateExternalDependencyProbe({});
      assert.deepEqual(result, { matched: false, reasons: [] });
    });
  });

  describe('evaluatePremortemDispatch — the one trigger', () => {
    it('dispatches on an external scoped package, match in reasons[]', () => {
      const decision = evaluatePremortemDispatch({
        planText: 'Needs @beestera/assets.',
        knownPackages: [],
        ownerRepo,
      });
      assert.equal(decision.critic, 'pre-mortem');
      assert.equal(decision.dispatch, true);
      assert.match(decision.reasons.join(' '), /@beestera\/assets/);
    });

    it('skips (ledgerable) when no marker fires', () => {
      const decision = evaluatePremortemDispatch({
        planText: 'Rename a helper and fix its test.',
        knownPackages: [],
        ownerRepo,
      });
      assert.equal(decision.dispatch, false);
      assert.equal(decision.reasons.length, 1);
      assert.match(decision.reasons[0], /no out-of-repo markers/);
    });

    it('is total — an empty call skips rather than throwing', () => {
      assert.equal(evaluatePremortemDispatch({}).dispatch, false);
    });
  });

  it('exports no consolidation arm and no size or heuristic trigger (Story #5312)', () => {
    assert.equal('evaluateConsolidationDispatch' in conditions, false);
    assert.equal('CONSOLIDATION_STORY_THRESHOLD' in conditions, false);
    const decision = evaluatePremortemDispatch({
      planText: 'Touches auth and drops a table.',
      knownPackages: [],
      ownerRepo,
      maxTickets: 1,
      ticketCount: 40,
      riskHeuristics: ['auth', 'drops a table'],
    });
    assert.equal(
      decision.dispatch,
      false,
      'neither a ticket count nor a heuristic phrase can dispatch the critic',
    );
  });
});
