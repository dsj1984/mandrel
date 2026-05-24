import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  resolveConfig,
  validateOrchestrationConfig,
} from '../.agents/scripts/lib/config-resolver.js';

// ---------------------------------------------------------------------------
// resolveConfig — canonical top-level shape (Epic #1720 Story #1739).
// Epic #2880 deleted the legacy `agentSettings` / `orchestration` output shim.
// ---------------------------------------------------------------------------
describe('resolveConfig — canonical github surface', () => {
  it('returns project / github / planning / delivery blocks', () => {
    const config = resolveConfig({ bustCache: true });
    for (const key of ['project', 'github', 'planning', 'delivery']) {
      assert.ok(key in config, `expected resolveConfig to surface ${key}`);
    }
  });

  it('does not expose the deleted legacy agentSettings / orchestration shim', () => {
    const config = resolveConfig({ bustCache: true });
    assert.equal('agentSettings' in config, false);
    assert.equal('orchestration' in config, false);
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
