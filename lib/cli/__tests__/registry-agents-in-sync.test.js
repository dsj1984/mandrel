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
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import { makeTempDir } from '../../../.agents/scripts/lib/test-temp.js';
import { registry } from '../registry.js';

const agentsInSync = registry.find((c) => c.name === 'agents-in-sync');

/**
 * A temp consumer with one unmaterialized role source and no dest — the
 * branch that consults the flag — plus the given config files.
 *
 * @param {Record<string, string>} [config] file name → raw content
 * @returns {string}
 */
function consumer(config = {}) {
  const root = makeTempDir('agents-in-sync-flag-');
  const agents = path.join(root, '.agents', 'agents');
  fs.mkdirSync(agents, { recursive: true });
  fs.writeFileSync(path.join(agents, 'story-worker.md'), '# worker\n');
  for (const [name, content] of Object.entries(config)) {
    fs.writeFileSync(path.join(root, name), content);
  }
  return root;
}

const routing = (r) => JSON.stringify({ delivery: { routing: r } });

describe('agents-in-sync — resolves roleScopedAgents from .agentrc.json (no AJV)', () => {
  it('defaults to fatal (true) when no .agentrc.json exists at all', () => {
    const result = agentsInSync.run({
      projectRoot: consumer(),
    });
    assert.equal(result.ok, false);
  });

  it('reads roleScopedAgents:false from the base .agentrc.json', () => {
    const result = agentsInSync.run({
      projectRoot: consumer({
        '.agentrc.json': routing({ roleScopedAgents: false }),
      }),
    });
    assert.equal(result.ok, true);
    assert.match(result.detail, /roleScopedAgents is disabled/);
  });

  it('reads roleScopedAgents:true explicitly from the base .agentrc.json', () => {
    const result = agentsInSync.run({
      projectRoot: consumer({
        '.agentrc.json': routing({ roleScopedAgents: true }),
      }),
    });
    assert.equal(result.ok, false);
  });

  it('a local override WINS over the base value (local:false over base:true)', () => {
    const result = agentsInSync.run({
      projectRoot: consumer({
        '.agentrc.json': routing({ roleScopedAgents: true }),
        '.agentrc.local.json': routing({ roleScopedAgents: false }),
      }),
    });
    assert.equal(
      result.ok,
      true,
      'local override must win over the base value',
    );
  });

  it('a local override WINS the other direction too (local:true over base:false)', () => {
    const result = agentsInSync.run({
      projectRoot: consumer({
        '.agentrc.json': routing({ roleScopedAgents: false }),
        '.agentrc.local.json': routing({ roleScopedAgents: true }),
      }),
    });
    assert.equal(result.ok, false);
  });

  it('degrades to the true default when .agentrc.json is malformed JSON, rather than throwing', () => {
    assert.doesNotThrow(() => {
      const result = agentsInSync.run({
        projectRoot: consumer({ '.agentrc.json': '{not valid json' }),
      });
      assert.equal(
        result.ok,
        false,
        'malformed config degrades to the true default',
      );
    });
  });

  it('an explicit roleScopedAgents opt bypasses the config reads entirely', () => {
    const result = agentsInSync.run({
      projectRoot: consumer({
        '.agentrc.json': routing({ roleScopedAgents: true }),
      }),
      roleScopedAgents: false, // overrides the base:true config
    });
    assert.equal(result.ok, true, 'explicit override must win over config');
  });
});
