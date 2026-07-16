// lib/cli/__tests__/registry-agents-in-sync.test.js
/**
 * Unit tests for the `agents-in-sync` doctor check's config-driven gate
 * (Story #4530, M7-B) — specifically the `.agentrc.json` /
 * `.agentrc.local.json` reads that resolve `delivery.routing.
 * roleScopedAgents` without pulling in the AJV-backed `resolveConfig()`
 * chain (registry.js's own "Node built-ins only" contract).
 *
 * `tests/cli/registry.test.js` covers the check's ok/detail/remedy shape via
 * the direct `roleScopedAgents` override seam; this file covers the config
 * READ path itself — default (no config), base-only, local-override, and
 * malformed-config-degrades-to-default.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';

import { registry } from '../registry.js';

const agentsInSync = registry.find((c) => c.name === 'agents-in-sync');

const ROOT = path.join(path.sep, 'consumer');
const SRC_DIR = path.join(ROOT, '.agents', 'agents');
const DEST_DIR = path.join(ROOT, '.claude', 'agents');
const AGENTRC = path.join(ROOT, '.agentrc.json');
const AGENTRC_LOCAL = path.join(ROOT, '.agentrc.local.json');

/** Minimal readFileSync-only fs fake keyed by absolute path. */
function makeFsFake(seed = {}) {
  const files = new Map(Object.entries(seed));
  return {
    readFileSync(p, _enc) {
      if (!files.has(p)) {
        const err = new Error(`ENOENT: no such file or directory, open '${p}'`);
        err.code = 'ENOENT';
        throw err;
      }
      return files.get(p);
    },
  };
}

/** One unmaterialized source, no dest — the branch that consults the flag. */
function readDirFixture() {
  return (dir) => {
    if (dir === SRC_DIR) return ['story-worker.md'];
    if (dir === DEST_DIR) return [];
    return [];
  };
}

describe('agents-in-sync — resolves roleScopedAgents from .agentrc.json (no AJV)', () => {
  it('defaults to fatal (true) when no .agentrc.json exists at all', () => {
    const result = agentsInSync.run({
      projectRoot: ROOT,
      fsImpl: makeFsFake({}),
      readDir: readDirFixture(),
    });
    assert.equal(result.ok, false);
  });

  it('reads roleScopedAgents:false from the base .agentrc.json', () => {
    const result = agentsInSync.run({
      projectRoot: ROOT,
      fsImpl: makeFsFake({
        [AGENTRC]: JSON.stringify({
          delivery: { routing: { roleScopedAgents: false } },
        }),
      }),
      readDir: readDirFixture(),
    });
    assert.equal(result.ok, true);
    assert.match(result.detail, /roleScopedAgents is disabled/);
  });

  it('reads roleScopedAgents:true explicitly from the base .agentrc.json', () => {
    const result = agentsInSync.run({
      projectRoot: ROOT,
      fsImpl: makeFsFake({
        [AGENTRC]: JSON.stringify({
          delivery: { routing: { roleScopedAgents: true } },
        }),
      }),
      readDir: readDirFixture(),
    });
    assert.equal(result.ok, false);
  });

  it('a local override WINS over the base value (local:false over base:true)', () => {
    const result = agentsInSync.run({
      projectRoot: ROOT,
      fsImpl: makeFsFake({
        [AGENTRC]: JSON.stringify({
          delivery: { routing: { roleScopedAgents: true } },
        }),
        [AGENTRC_LOCAL]: JSON.stringify({
          delivery: { routing: { roleScopedAgents: false } },
        }),
      }),
      readDir: readDirFixture(),
    });
    assert.equal(
      result.ok,
      true,
      'local override must win over the base value',
    );
  });

  it('a local override WINS the other direction too (local:true over base:false)', () => {
    const result = agentsInSync.run({
      projectRoot: ROOT,
      fsImpl: makeFsFake({
        [AGENTRC]: JSON.stringify({
          delivery: { routing: { roleScopedAgents: false } },
        }),
        [AGENTRC_LOCAL]: JSON.stringify({
          delivery: { routing: { roleScopedAgents: true } },
        }),
      }),
      readDir: readDirFixture(),
    });
    assert.equal(result.ok, false);
  });

  it('degrades to the true default when .agentrc.json is malformed JSON, rather than throwing', () => {
    assert.doesNotThrow(() => {
      const result = agentsInSync.run({
        projectRoot: ROOT,
        fsImpl: makeFsFake({ [AGENTRC]: '{not valid json' }),
        readDir: readDirFixture(),
      });
      assert.equal(
        result.ok,
        false,
        'malformed config degrades to the true default',
      );
    });
  });

  it('an explicit roleScopedAgents opt bypasses the config reads entirely', () => {
    const fsFake = makeFsFake({
      [AGENTRC]: JSON.stringify({
        delivery: { routing: { roleScopedAgents: true } },
      }),
    });
    const result = agentsInSync.run({
      projectRoot: ROOT,
      fsImpl: fsFake,
      roleScopedAgents: false, // overrides the base:true config
      readDir: readDirFixture(),
    });
    assert.equal(result.ok, true, 'explicit override must win over config');
  });
});
