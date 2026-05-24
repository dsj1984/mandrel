// tests/contract/config/coverage-timeout-honored.test.js
/**
 * Contract test — Story #2959.
 *
 * Pins the two-part fix that makes operator-set
 * `delivery.quality.gates.coverage.timeoutMs` reach the resolver:
 *
 *   1. AJV `coverageGate` schema accepts a positive integer `timeoutMs`
 *      and rejects non-integer / non-positive values (previously
 *      `additionalProperties: false` silently stripped the key).
 *   2. `getQuality(config)` reads from the canonical
 *      `config.delivery.quality.*` path so an operator override
 *      propagates to `quality.coverage.timeoutMs` instead of being
 *      lost to framework defaults.
 *
 * The bug was diagnosed during Epic #2880 delivery: a `.agentrc.json`
 * carrying `timeoutMs: 1_800_000` still SIGKILL'd at the 600_000 ms
 * default because the schema dropped the key and several internal
 * callers passed `getQuality({ agentSettings })` — `agentSettings` is
 * not part of the post-Epic-#2880 resolver output, so the read
 * returned framework defaults.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { COVERAGE_GATE_DEFAULTS } from '../../../.agents/scripts/lib/config/quality.js';
import {
  getQuality,
  resolveConfig,
} from '../../../.agents/scripts/lib/config-resolver.js';
import { getAgentrcValidator } from '../../../.agents/scripts/lib/config-schema.js';

const CANONICAL_TIMEOUT = 1_800_000;

function writeAgentrc(root, doc) {
  fs.writeFileSync(
    path.join(root, '.agentrc.json'),
    JSON.stringify(doc),
    'utf8',
  );
}

describe('contract/config/coverage-timeout-honored', () => {
  describe('resolver — getQuality reads operator timeoutMs', () => {
    let tmpRoot;

    beforeEach(() => {
      tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mandrel-cov-to-'));
    });

    afterEach(() => {
      if (tmpRoot) {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
      }
    });

    it('propagates delivery.quality.gates.coverage.timeoutMs to getQuality(config).coverage.timeoutMs', () => {
      writeAgentrc(tmpRoot, {
        project: {
          paths: { agentRoot: '.agents', docsRoot: 'docs', tempRoot: 'temp' },
        },
        delivery: {
          quality: {
            gates: {
              coverage: { timeoutMs: CANONICAL_TIMEOUT },
            },
          },
        },
      });

      const config = resolveConfig({ cwd: tmpRoot, bustCache: true });
      const quality = getQuality(config);

      assert.equal(
        quality.coverage.timeoutMs,
        CANONICAL_TIMEOUT,
        'operator-set coverage.timeoutMs must round-trip through the resolver',
      );
    });

    it('falls back to the framework default when timeoutMs is omitted', () => {
      writeAgentrc(tmpRoot, {
        project: {
          paths: { agentRoot: '.agents', docsRoot: 'docs', tempRoot: 'temp' },
        },
      });

      const config = resolveConfig({ cwd: tmpRoot, bustCache: true });
      const quality = getQuality(config);

      assert.equal(
        quality.coverage.timeoutMs,
        COVERAGE_GATE_DEFAULTS.timeoutMs,
      );
    });
  });

  describe('AJV — coverageGate.timeoutMs validation', () => {
    it('accepts a positive integer timeoutMs', () => {
      const validate = getAgentrcValidator();
      const doc = {
        project: {
          paths: { agentRoot: '.agents', docsRoot: 'docs', tempRoot: 'temp' },
        },
        delivery: {
          quality: {
            gates: {
              coverage: { timeoutMs: CANONICAL_TIMEOUT },
            },
          },
        },
      };

      const ok = validate(doc);

      assert.equal(
        ok,
        true,
        `AJV must accept integer timeoutMs — errors: ${JSON.stringify(
          validate.errors,
        )}`,
      );
    });

    it('rejects a non-integer timeoutMs (e.g. floating-point)', () => {
      const validate = getAgentrcValidator();
      const doc = {
        project: {
          paths: { agentRoot: '.agents', docsRoot: 'docs', tempRoot: 'temp' },
        },
        delivery: {
          quality: {
            gates: {
              coverage: { timeoutMs: 1.5 },
            },
          },
        },
      };

      const ok = validate(doc);

      assert.equal(ok, false, 'AJV must reject non-integer timeoutMs');
      const messages = (validate.errors ?? [])
        .map((e) => `${e.instancePath} ${e.message}`)
        .join(' | ');
      assert.match(
        messages,
        /must be integer|integer/i,
        `expected integer-type error, got: ${messages}`,
      );
    });

    it('rejects a zero or negative timeoutMs', () => {
      const validate = getAgentrcValidator();
      for (const bad of [0, -1, -1000]) {
        const doc = {
          project: {
            paths: {
              agentRoot: '.agents',
              docsRoot: 'docs',
              tempRoot: 'temp',
            },
          },
          delivery: {
            quality: {
              gates: {
                coverage: { timeoutMs: bad },
              },
            },
          },
        };

        const ok = validate(doc);

        assert.equal(
          ok,
          false,
          `AJV must reject timeoutMs=${bad} (must be >= 1)`,
        );
      }
    });
  });
});
