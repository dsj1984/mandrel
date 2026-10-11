import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildMutationManifest,
  PHASE_GROUPS,
} from '../../../.agents/scripts/lib/bootstrap/manifest.js';

const groupsOf = (entries) => [...new Set(entries.map((e) => e.phaseGroup))];

describe('bootstrap manifest — buildMutationManifest', () => {
  it('defaults to IDE wiring, repo config and GitHub admin, in that order', () => {
    const entries = buildMutationManifest();
    assert.deepEqual(groupsOf(entries), [
      PHASE_GROUPS.IDE_WIRING,
      PHASE_GROUPS.REPO_CONFIG,
      PHASE_GROUPS.GITHUB_ADMIN,
    ]);
    assert.equal(entries.length, 12);
    assert.ok(
      entries.every((e) =>
        ['phaseGroup', 'target', 'action', 'detail', 'reversible'].every(
          (k) => k in e,
        ),
      ),
    );
    assert.equal(entries[3].target, '.git');
    assert.equal(entries[3].reversible, false);
    assert.equal(entries[7].target, 'the GitHub repository (repo)');
    const ownerOnly = buildMutationManifest({ answers: { owner: 'acme' } });
    assert.equal(ownerOnly[7].target, 'the GitHub repository (repo)');
  });

  it('adds quality gates and names the repo from the answers', () => {
    const entries = buildMutationManifest({
      withQuality: true,
      answers: { owner: 'acme', repo: 'widgets' },
    });
    const quality = entries.filter(
      (e) => e.phaseGroup === PHASE_GROUPS.QUALITY_GATES,
    );
    assert.deepEqual(
      quality.map((e) => e.target),
      ['.husky/pre-commit', 'package.json', '.agentrc.json'],
    );
    const github = entries.filter(
      (e) => e.phaseGroup === PHASE_GROUPS.GITHUB_ADMIN,
    );
    assert.ok(github.every((e) => e.target.startsWith('acme/widgets ')));
    assert.ok(github.every((e) => e.reversible === false));
  });

  it('omits GitHub admin under skipGithub', () => {
    const entries = buildMutationManifest({
      skipGithub: true,
      answers: { owner: 'acme' },
    });
    assert.ok(entries.every((e) => e.phaseGroup !== PHASE_GROUPS.GITHUB_ADMIN));
    assert.equal(entries.length, 7);
  });
});
