/**
 * Story #5300 — the follow-up ownership routing SSOT.
 *
 * This module is the surface ADR 20260911-5300 governs, and its whole reason
 * to exist is that the predecessor resolved an unset bucket to the consumer's
 * own repo. So the assertions that matter most are the negative ones: an
 * unresolvable bucket must come back `routable: false` with the key that
 * would fix it, never as a plausible substitute.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DEFAULT_FRAMEWORK_REPO,
  formatRepoSlug,
  OWNERSHIP_BUCKETS,
  parseRepoSlug,
  resolveOwnershipRepos,
  routeOwnership,
} from '../../../.agents/scripts/lib/github/framework-repo.js';

/** The `.agentrc` key each bucket is configured under, asserted verbatim. */
const CONFIG_KEY = {
  consumer: 'github.owner / github.repo',
  framework: 'github.followUpRepos.framework',
  platform: 'github.followUpRepos.platform',
};

describe('parseRepoSlug', () => {
  it('parses a well-formed slug, trimming surrounding space', () => {
    assert.deepEqual(parseRepoSlug('acme/product'), {
      owner: 'acme',
      repo: 'product',
    });
    assert.deepEqual(parseRepoSlug('  acme/product  '), {
      owner: 'acme',
      repo: 'product',
    });
  });

  it('returns null for every malformed shape rather than guessing', () => {
    for (const bad of [
      undefined,
      null,
      42,
      {},
      '',
      'no-slash',
      'a/b/c',
      '/product',
      'acme/',
    ]) {
      assert.equal(
        parseRepoSlug(bad),
        null,
        `expected null for ${JSON.stringify(bad)}`,
      );
    }
  });
});

describe('formatRepoSlug', () => {
  it('round-trips a parsed slug', () => {
    assert.equal(formatRepoSlug(parseRepoSlug('acme/product')), 'acme/product');
  });

  it('returns null for anything that is not a usable pair', () => {
    for (const bad of [
      undefined,
      null,
      'acme/product',
      {},
      { owner: 'acme' },
      { repo: 'product' },
      { owner: 'acme', repo: '' },
      { owner: '   ', repo: 'product' },
      { owner: 1, repo: 2 },
    ]) {
      assert.equal(
        formatRepoSlug(bad),
        null,
        `expected null for ${JSON.stringify(bad)}`,
      );
    }
  });
});

describe('resolveOwnershipRepos', () => {
  it('resolves all three buckets when all three are configured', () => {
    const repos = resolveOwnershipRepos({
      github: {
        owner: 'acme',
        repo: 'product',
        followUpRepos: { framework: 'acme/mandrel', platform: 'acme/platform' },
      },
    });
    assert.deepEqual(repos.consumer, { owner: 'acme', repo: 'product' });
    assert.deepEqual(repos.framework, { owner: 'acme', repo: 'mandrel' });
    assert.deepEqual(repos.platform, { owner: 'acme', repo: 'platform' });
  });

  it('defaults only the framework bucket', () => {
    const repos = resolveOwnershipRepos({
      github: { owner: 'acme', repo: 'product' },
    });
    assert.deepEqual(repos.framework, parseRepoSlug(DEFAULT_FRAMEWORK_REPO));
    assert.equal(repos.platform, null, 'nothing can guess a shared repo');
  });

  it('is total — an absent or malformed config yields nulls, not throws', () => {
    for (const config of [
      undefined,
      null,
      {},
      { github: null },
      { github: {} },
    ]) {
      const repos = resolveOwnershipRepos(config);
      assert.equal(repos.consumer, null);
      assert.equal(repos.platform, null);
      assert.deepEqual(repos.framework, parseRepoSlug(DEFAULT_FRAMEWORK_REPO));
    }
  });

  it('treats a blank owner or repo as unset', () => {
    const repos = resolveOwnershipRepos({
      github: { owner: '   ', repo: 'product' },
    });
    assert.equal(repos.consumer, null);
  });
});

describe('routeOwnership', () => {
  const repos = {
    consumer: { owner: 'acme', repo: 'product' },
    framework: { owner: 'dsj1984', repo: 'mandrel' },
    platform: null,
  };
  const currentRepo = repos.consumer;

  it('routes a configured bucket and reports whether it is cross-repo', () => {
    const consumer = routeOwnership({ bucket: 'consumer', repos, currentRepo });
    assert.equal(consumer.routable, true);
    assert.equal(consumer.crossRepo, false);
    assert.equal(consumer.missingKey, null);

    const framework = routeOwnership({
      bucket: 'framework',
      repos,
      currentRepo,
    });
    assert.equal(framework.routable, true);
    assert.equal(framework.crossRepo, true);
    assert.deepEqual(framework.routedRepo, {
      owner: 'dsj1984',
      repo: 'mandrel',
    });
  });

  it('reports an unconfigured bucket as unroutable, naming the key that fixes it', () => {
    const routed = routeOwnership({ bucket: 'platform', repos, currentRepo });
    assert.equal(routed.routable, false);
    assert.equal(routed.routedRepo, null, 'never a substituted repository');
    assert.equal(routed.missingKey, 'github.followUpRepos.platform');
    assert.equal(routed.crossRepo, false);
  });

  it('refuses an unknown bucket by name', () => {
    const routed = routeOwnership({ bucket: 'nowhere', repos, currentRepo });
    assert.equal(routed.routable, false);
    assert.match(routed.missingKey, /unknown ownership bucket/);
  });

  it('is total — no repos map, no currentRepo, no arguments at all', () => {
    const noRepos = routeOwnership({ bucket: 'framework' });
    assert.equal(noRepos.routable, false);
    assert.equal(noRepos.missingKey, CONFIG_KEY.framework);

    const noCurrent = routeOwnership({ bucket: 'framework', repos });
    assert.equal(noCurrent.routable, true);
    assert.equal(
      noCurrent.crossRepo,
      false,
      'cross-repo is unknowable without a current repo, so it is not asserted',
    );

    const nothing = routeOwnership();
    assert.equal(nothing.routable, false);
  });

  it('treats a half-formed repo entry as unroutable', () => {
    const routed = routeOwnership({
      bucket: 'platform',
      repos: { ...repos, platform: { owner: 'acme' } },
      currentRepo,
    });
    assert.equal(routed.routable, false);
  });

  it('names the operator-settable key for every bucket in the closed set', () => {
    // An unroutable bucket is only actionable if it says which key to set.
    for (const bucket of OWNERSHIP_BUCKETS) {
      const routed = routeOwnership({ bucket, repos: {}, currentRepo: null });
      assert.equal(
        routed.missingKey,
        CONFIG_KEY[bucket],
        `${bucket} must name the key an operator would set`,
      );
    }
  });
});
