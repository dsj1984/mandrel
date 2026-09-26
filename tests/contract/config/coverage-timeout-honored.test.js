// tests/contract/config/coverage-timeout-honored.test.js
/**
 * Contract test — Story #2959, removed by Story #5382, restored by #5485.
 *
 * Story #2959 made an operator-set `delivery.quality.gates.coverage.timeoutMs`
 * reach the resolver: the schema used to strip the key silently, so a config
 * asking for 30 minutes still SIGKILL'd at the 600_000 ms default. Story
 * #5382 folded the key into a constant; Story #5485 re-admitted it for a
 * consumer on a shared runner host. The contract: a timeout the operator
 * writes reaches `getQuality(...).coverage.timeoutMs` through the real
 * resolver, and one outside the schema bounds is refused loudly at load.
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
  let tmpRoot;

  beforeEach(() => {
    tmpRoot = makeTempDir('mandrel-cov-to-');
  });

  afterEach(() => {
    if (tmpRoot) {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('honours an operator-set coverage.timeoutMs end to end', () => {
    writeAgentrc(tmpRoot, {
      project: { paths: PATHS },
      delivery: {
        quality: { gates: { coverage: { timeoutMs: 1_800_000 } } },
      },
    });
    const config = resolveConfig({ cwd: tmpRoot, bustCache: true });
    assert.equal(getQuality(config).coverage.timeoutMs, 1_800_000);
  });

  it('refuses an out-of-bounds coverage.timeoutMs, loudly', () => {
    writeAgentrc(tmpRoot, {
      project: { paths: PATHS },
      delivery: { quality: { gates: { coverage: { timeoutMs: 1_000 } } } },
    });
    assert.throws(
      () => resolveConfig({ cwd: tmpRoot, bustCache: true }),
      /timeoutMs/,
    );
  });

  it('resolves the framework default when the key is absent', () => {
    writeAgentrc(tmpRoot, { project: { paths: PATHS } });
    const config = resolveConfig({ cwd: tmpRoot, bustCache: true });
    assert.equal(
      getQuality(config).coverage.timeoutMs,
      COVERAGE_GATE_DEFAULTS.timeoutMs,
    );
  });
});
