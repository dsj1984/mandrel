import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { validateOrchestrationConfig } from '../.agents/scripts/lib/config-resolver.js';
import { getSettingsValidator } from '../.agents/scripts/lib/config-settings-schema.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

// Acceptance gate for Epic #730 Story 4 (Task #756): both shipped configs —
// the project's `.agentrc.json` and the distributed `default-agentrc.json` —
// must validate cleanly under the schema, including hard-required path roots
// and every conditional-required key whose parent block is enabled.
const SHIPPED_CONFIGS = ['.agentrc.json', '.agents/default-agentrc.json'];

function loadAndValidate(relPath) {
  const raw = JSON.parse(
    readFileSync(path.join(PROJECT_ROOT, relPath), 'utf8'),
  );
  const settings = raw.agentSettings ?? {};
  const validateSettings = getSettingsValidator();
  const ok = validateSettings(settings);
  return {
    raw,
    settings,
    settingsOk: ok,
    settingsErrors: validateSettings.errors ?? [],
  };
}

describe('shipped configs validate cleanly under the updated schema', () => {
  for (const relPath of SHIPPED_CONFIGS) {
    it(`${relPath} — agentSettings passes the schema`, () => {
      const { settingsOk, settingsErrors } = loadAndValidate(relPath);
      assert.equal(
        settingsOk,
        true,
        `agentSettings validation errors: ${JSON.stringify(settingsErrors, null, 2)}`,
      );
    });

    it(`${relPath} — orchestration passes validateOrchestrationConfig`, () => {
      const { raw } = loadAndValidate(relPath);
      assert.doesNotThrow(() =>
        validateOrchestrationConfig(raw.orchestration ?? null),
      );
    });

    it(`${relPath} — declares the three required path roots explicitly under paths`, () => {
      const { settings } = loadAndValidate(relPath);
      const paths = settings.paths ?? {};
      for (const key of ['agentRoot', 'docsRoot', 'tempRoot']) {
        assert.ok(
          typeof paths[key] === 'string' && paths[key].length > 0,
          `${relPath} must declare a non-empty agentSettings.paths.${key}`,
        );
      }
    });

    it(`${relPath} — declares conditional-required keys for every enabled block`, () => {
      const { raw } = loadAndValidate(relPath);
      const orch = raw.orchestration ?? {};

      const deliverRunner = orch.runners?.deliverRunner;
      if (deliverRunner && deliverRunner.enabled !== false) {
        assert.ok(
          Number.isInteger(deliverRunner.concurrencyCap) &&
            deliverRunner.concurrencyCap >= 1,
          `${relPath}: runners.deliverRunner.concurrencyCap is required when enabled !== false`,
        );
      }

      if (orch.worktreeIsolation && orch.worktreeIsolation.enabled === true) {
        assert.ok(
          typeof orch.worktreeIsolation.root === 'string' &&
            orch.worktreeIsolation.root.length > 0,
          `${relPath}: worktreeIsolation.root is required when enabled === true`,
        );
      }

      const crap = raw.agentSettings?.maintainability?.crap;
      if (crap && crap.enabled === true && crap.requireCoverage === true) {
        assert.ok(
          typeof crap.coveragePath === 'string' && crap.coveragePath.length > 0,
          `${relPath}: maintainability.crap.coveragePath is required when enabled+requireCoverage are true`,
        );
      }
    });
  }
});
