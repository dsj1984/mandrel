import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import { resolveConfig } from '../../.agents/scripts/lib/config-resolver.js';
import { createRuntimeContext } from '../../.agents/scripts/lib/runtime-context.js';

describe('resolveConfig with injected ctx.fs', () => {
  it('reads .agentrc.json through ctx.fs when a runtime context is passed', () => {
    const fakeRoot = path.resolve('/fake/ctx-root');
    const agentrcPath = path.join(fakeRoot, '.agentrc.json');
    const reads = [];
    const fakeFs = {
      existsSync: (p) => p === agentrcPath,
      readFileSync: (p) => {
        reads.push(p);
        return JSON.stringify({
          project: {
            baseBranch: 'develop',
            paths: {
              agentRoot: '.agents',
              docsRoot: 'docs',
              tempRoot: 'temp',
            },
          },
        });
      },
    };
    const ctx = createRuntimeContext({ fs: fakeFs });

    const resolved = resolveConfig({
      cwd: fakeRoot,
      bustCache: true,
      ctx,
    });

    assert.equal(resolved.source, agentrcPath);
    assert.equal(resolved.project.baseBranch, 'develop');
    // Legacy shim preserves the baseBranch under agentSettings for
    // in-flight call sites that haven't migrated yet.
    assert.equal(resolved.agentSettings.baseBranch, 'develop');
    assert.deepEqual(reads, [agentrcPath]);
  });

  it('falls back to zero-config defaults when ctx.fs reports the file is missing', () => {
    const fakeRoot = path.resolve('/fake/empty-root');
    const fakeFs = {
      existsSync: () => false,
      readFileSync: () => {
        throw new Error('should not read');
      },
    };
    const ctx = createRuntimeContext({ fs: fakeFs });

    const resolved = resolveConfig({
      cwd: fakeRoot,
      bustCache: true,
      ctx,
    });

    assert.equal(resolved.source, 'built-in defaults');
    assert.equal(resolved.github, null);
    // Zero-config defaults now ship project.paths.agentRoot (no schema
    // gate against the synthetic zero-config wrapper).
    assert.equal(resolved.project.paths.agentRoot, '.agents');
    assert.equal(resolved.project.paths.scriptsRoot, '.agents/scripts');
  });
});
