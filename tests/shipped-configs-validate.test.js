import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { validateOrchestrationConfig } from '../.agents/scripts/lib/config-resolver.js';
import { getAgentrcValidator } from '../.agents/scripts/lib/config-settings-schema.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

// Both shipped configs — the project's `.agentrc.json` and the distributed
// `.agents/default-agentrc.json` — must validate cleanly under the
// post-reshape schema (Epic #1720 Story #1739).
const SHIPPED_CONFIGS = ['.agentrc.json', '.agents/default-agentrc.json'];

function loadAndValidate(relPath) {
  const raw = JSON.parse(
    readFileSync(path.join(PROJECT_ROOT, relPath), 'utf8'),
  );
  const validateAgentrc = getAgentrcValidator();
  const ok = validateAgentrc(raw);
  return {
    raw,
    ok,
    errors: validateAgentrc.errors ?? [],
  };
}

describe('shipped configs validate cleanly under the post-reshape schema', () => {
  for (const relPath of SHIPPED_CONFIGS) {
    it(`${relPath} — full doc passes the schema`, () => {
      const { ok, errors } = loadAndValidate(relPath);
      assert.equal(
        ok,
        true,
        `validation errors: ${JSON.stringify(errors, null, 2)}`,
      );
    });

    it(`${relPath} — passes the resolver security checks`, () => {
      const { raw } = loadAndValidate(relPath);
      assert.doesNotThrow(() => validateOrchestrationConfig(raw));
    });

    it(`${relPath} — declares the three required path roots`, () => {
      const { raw } = loadAndValidate(relPath);
      const paths = raw.project?.paths ?? {};
      for (const key of ['agentRoot', 'docsRoot', 'tempRoot']) {
        assert.ok(
          typeof paths[key] === 'string' && paths[key].length > 0,
          `${relPath} must declare a non-empty project.paths.${key}`,
        );
      }
    });

    it(`${relPath} — declares conditional-required keys for every enabled block`, () => {
      const { raw } = loadAndValidate(relPath);
      const delivery = raw.delivery ?? {};

      if (delivery.worktreeIsolation?.enabled === true) {
        assert.ok(
          typeof delivery.worktreeIsolation.root === 'string' &&
            delivery.worktreeIsolation.root.length > 0,
          `${relPath}: delivery.worktreeIsolation.root is required when enabled === true`,
        );
      }

      const crap = delivery.quality?.crap;
      if (crap && crap.enabled === true && crap.requireCoverage === true) {
        assert.ok(
          typeof crap.coveragePath === 'string' && crap.coveragePath.length > 0,
          `${relPath}: delivery.quality.crap.coveragePath is required when enabled+requireCoverage are true`,
        );
      }
    });
  }
});
