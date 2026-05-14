import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  resolveConfig,
  validateOrchestrationConfig,
} from '../.agents/scripts/lib/config-resolver.js';

// ---------------------------------------------------------------------------
// resolveConfig — new top-level shape + legacy shim (Epic #1720 Story #1739)
// ---------------------------------------------------------------------------
describe('resolveConfig — github + legacy orchestration shim', () => {
  it('returns project / github / planning / delivery blocks', () => {
    const config = resolveConfig({ bustCache: true });
    for (const key of ['project', 'github', 'planning', 'delivery']) {
      assert.ok(key in config, `expected resolveConfig to surface ${key}`);
    }
  });

  it('preserves a legacy orchestration shim for in-flight callers', () => {
    const config = resolveConfig({ bustCache: true });
    assert.ok('orchestration' in config);
    if (config.source.includes('.agentrc.json') && config.github) {
      assert.ok(config.orchestration !== null);
      assert.equal(config.orchestration.provider, 'github');
      assert.equal(config.orchestration.github.owner, config.github.owner);
    }
  });

  it('reads github.owner/repo from this repo .agentrc.json', () => {
    const config = resolveConfig({ bustCache: true });
    if (config.source.includes('.agentrc.json')) {
      assert.ok(config.github !== null);
      assert.equal(typeof config.github.owner, 'string');
      assert.equal(typeof config.github.repo, 'string');
    }
  });
});

// ---------------------------------------------------------------------------
// validateOrchestrationConfig — security checks (post-reshape behaviour)
// ---------------------------------------------------------------------------
describe('validateOrchestrationConfig — security checks only', () => {
  it('null config passes (not configured)', () => {
    assert.doesNotThrow(() => validateOrchestrationConfig(null));
  });

  it('undefined config passes', () => {
    assert.doesNotThrow(() => validateOrchestrationConfig(undefined));
  });

  it('rejects non-object input', () => {
    assert.throws(
      () => validateOrchestrationConfig('string'),
      /expected an object/,
    );
  });

  it('rejects array input', () => {
    assert.throws(() => validateOrchestrationConfig([]), /expected an object/);
  });

  it('passes a clean post-reshape config', () => {
    assert.doesNotThrow(() =>
      validateOrchestrationConfig({
        github: {
          owner: 'dsj1984',
          repo: 'mandrel',
          operatorHandle: '@dsj1984',
        },
        delivery: {
          worktreeIsolation: { enabled: true, root: '.worktrees' },
        },
      }),
    );
  });

  it('rejects shell injection in github.owner', () => {
    assert.throws(
      () =>
        validateOrchestrationConfig({
          github: { owner: 'org; rm -rf /', repo: 'r' },
        }),
      /Shell meta-characters detected in github\.owner/,
    );
  });

  it('rejects shell injection in github.repo', () => {
    assert.throws(
      () =>
        validateOrchestrationConfig({
          github: { owner: 'o', repo: 'r`whoami`' },
        }),
      /Shell meta-characters detected in github\.repo/,
    );
  });

  it('rejects shell injection in github.operatorHandle', () => {
    assert.throws(
      () =>
        validateOrchestrationConfig({
          github: { owner: 'o', repo: 'r', operatorHandle: '@user|cat' },
        }),
      /Shell meta-characters detected in github\.operatorHandle/,
    );
  });

  it('rejects shell injection in delivery.worktreeIsolation.root', () => {
    assert.throws(
      () =>
        validateOrchestrationConfig({
          github: { owner: 'o', repo: 'r' },
          delivery: { worktreeIsolation: { root: '.worktrees; ls' } },
        }),
      /Shell meta-characters/,
    );
  });

  it('rejects worktree root resolving outside the repo', () => {
    assert.throws(
      () =>
        validateOrchestrationConfig({
          github: { owner: 'o', repo: 'r' },
          delivery: { worktreeIsolation: { root: '../escape' } },
        }),
      /resolves outside the repo root/,
    );
  });
});
