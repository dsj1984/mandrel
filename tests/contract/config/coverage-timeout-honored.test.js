// tests/contract/config/coverage-timeout-honored.test.js
/**
 * Contract test — Story #2959, updated by Story #5382.
 *
 * Story #2959 made an operator-set `delivery.quality.gates.coverage.timeoutMs`
 * reach the resolver: the schema used to strip the key silently, so a config
 * asking for 30 minutes still SIGKILL'd at the 600_000 ms default.
 *
 * Story #5382 removed the key — no surveyed config ever set it — and fixed the
 * capture timeout at `COVERAGE_GATE_DEFAULTS.timeoutMs`. The contract that
 * survives is the one #2959 was really about: a timeout the operator writes is
 * never *silently* dropped. The key is now rejected loudly at load, naming
 * itself, and the resolver always reports the constant.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { COVERAGE_GATE_DEFAULTS } from '../../../.agents/scripts/lib/config/quality.js';
import {
  getQuality,
  resolveConfig,
} from '../../../.agents/scripts/lib/config-resolver.js';
import { getAgentrcValidator } from '../../../.agents/scripts/lib/config-schema.js';
import { makeTempDir } from '../../../.agents/scripts/lib/test-temp.js';

const PATHS = { agentRoot: '.agents', docsRoot: 'docs', tempRoot: 'temp' };

function writeAgentrc(root, doc) {
  fs.writeFileSync(
    path.join(root, '.agentrc.json'),
    JSON.stringify(doc),
    'utf8',
  );
}

describe('contract/config/coverage-timeout-honored', () => {
  describe('resolver — the capture timeout is the fixed constant', () => {
    let tmpRoot;

    beforeEach(() => {
      tmpRoot = makeTempDir('mandrel-cov-to-');
    });

    afterEach(() => {
      if (tmpRoot) {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
      }
    });

    it('refuses a config that still sets coverage.timeoutMs, loudly', () => {
      writeAgentrc(tmpRoot, {
        project: { paths: PATHS },
        delivery: {
          quality: { gates: { coverage: { timeoutMs: 1_800_000 } } },
        },
      });
      assert.throws(
        () => resolveConfig({ cwd: tmpRoot, bustCache: true }),
        /gates\/coverage must NOT have additional properties/,
      );
    });

    it('resolves the framework constant when the key is absent', () => {
      writeAgentrc(tmpRoot, { project: { paths: PATHS } });
      const config = resolveConfig({ cwd: tmpRoot, bustCache: true });
      assert.equal(
        getQuality(config).coverage.timeoutMs,
        COVERAGE_GATE_DEFAULTS.timeoutMs,
      );
      assert.equal(COVERAGE_GATE_DEFAULTS.timeoutMs, 600_000);
    });
  });

  describe('AJV — coverageGate.timeoutMs is rejected by name', () => {
    it('rejects every value, naming the key', () => {
      const validate = getAgentrcValidator();
      for (const timeoutMs of [1_800_000, 1.5, 0]) {
        const ok = validate({
          project: { paths: PATHS },
          delivery: { quality: { gates: { coverage: { timeoutMs } } } },
        });
        assert.equal(ok, false, `timeoutMs=${timeoutMs} must be rejected`);
        assert.ok(
          validate.errors.some(
            (e) => e.params?.additionalProperty === 'timeoutMs',
          ),
          JSON.stringify(validate.errors),
        );
      }
    });
  });
});
