// lib/migrations/steps/__tests__/2.1.0-retire-verify-concurrency-cap.test.js
/**
 * Unit tests for the Story #4545 migration step — strips the retired
 * `delivery.deliverRunner.verifyConcurrencyCap` key from a consumer's
 * `.agentrc.json` AND `.agentrc.local.json`. The local file matters because
 * the resolver deep-merges it over the committed config and validates the
 * merged result against a sub-schema declaring `additionalProperties: false`,
 * so a key surviving in either file is a hard AJV failure on upgrade.
 *
 * All tests drive `detect`/`apply` against an in-memory fake fs
 * (testing-standards § Unit) — no real filesystem I/O.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';

import { retireVerifyConcurrencyCap } from '../2.1.0-retire-verify-concurrency-cap.js';

const PROJECT_ROOT = '/consumer';
const AGENTRC_PATH = path.join(PROJECT_ROOT, '.agentrc.json');
const AGENTRC_LOCAL_PATH = path.join(PROJECT_ROOT, '.agentrc.local.json');

/**
 * @param {{ base?: object | null, local?: object | null }} initial
 * @returns {{ ctx: object, read: (p: string) => object }}
 */
function makeCtx({ base = null, local = null } = {}) {
  const files = new Map();
  if (base !== null) files.set(AGENTRC_PATH, JSON.stringify(base, null, 2));
  if (local !== null)
    files.set(AGENTRC_LOCAL_PATH, JSON.stringify(local, null, 2));

  const fs = {
    readFileSync(filePath) {
      if (!files.has(filePath)) {
        const err = new Error(`ENOENT: ${filePath}`);
        err.code = 'ENOENT';
        throw err;
      }
      return files.get(filePath);
    },
    writeFileSync(filePath, contents) {
      files.set(filePath, contents);
    },
  };

  return {
    ctx: { projectRoot: PROJECT_ROOT, fs },
    read: (filePath) => JSON.parse(files.get(filePath)),
  };
}

describe('retireVerifyConcurrencyCap — detect', () => {
  it('detects the key in .agentrc.json', () => {
    const { ctx } = makeCtx({
      base: { delivery: { deliverRunner: { verifyConcurrencyCap: 4 } } },
    });
    assert.equal(retireVerifyConcurrencyCap.detect(ctx), true);
  });

  it('detects the key in .agentrc.local.json even when the committed config is clean', () => {
    const { ctx } = makeCtx({
      base: { delivery: { deliverRunner: { concurrencyCap: 3 } } },
      local: { delivery: { deliverRunner: { verifyConcurrencyCap: 8 } } },
    });
    assert.equal(
      retireVerifyConcurrencyCap.detect(ctx),
      true,
      'a local override alone still fails the merged-config AJV check',
    );
  });

  it('returns false when neither file carries the key', () => {
    const { ctx } = makeCtx({
      base: { delivery: { deliverRunner: { concurrencyCap: 3 } } },
    });
    assert.equal(retireVerifyConcurrencyCap.detect(ctx), false);
  });

  it('returns false when no config exists on disk', () => {
    const { ctx } = makeCtx({});
    assert.equal(retireVerifyConcurrencyCap.detect(ctx), false);
  });
});

describe('retireVerifyConcurrencyCap — apply', () => {
  it('strips the key while preserving its live sibling', () => {
    const { ctx, read } = makeCtx({
      base: {
        delivery: {
          deliverRunner: { concurrencyCap: 3, verifyConcurrencyCap: 4 },
        },
      },
    });
    retireVerifyConcurrencyCap.apply(ctx);
    assert.deepEqual(read(AGENTRC_PATH).delivery.deliverRunner, {
      concurrencyCap: 3,
    });
  });

  it('strips the key from both files in one pass', () => {
    const { ctx, read } = makeCtx({
      base: {
        delivery: {
          deliverRunner: { concurrencyCap: 3, verifyConcurrencyCap: 4 },
        },
      },
      local: { delivery: { deliverRunner: { verifyConcurrencyCap: 8 } } },
    });
    retireVerifyConcurrencyCap.apply(ctx);
    assert.deepEqual(read(AGENTRC_PATH).delivery.deliverRunner, {
      concurrencyCap: 3,
    });
    assert.equal(
      Object.hasOwn(read(AGENTRC_LOCAL_PATH).delivery, 'deliverRunner'),
      false,
      'an override block left empty by the strip is removed, not left as {}',
    );
  });

  it('drops the deliverRunner block entirely when the key was its only member', () => {
    const { ctx, read } = makeCtx({
      base: { delivery: { deliverRunner: { verifyConcurrencyCap: 4 } } },
    });
    retireVerifyConcurrencyCap.apply(ctx);
    assert.equal(
      Object.hasOwn(read(AGENTRC_PATH).delivery, 'deliverRunner'),
      false,
    );
  });

  it('is idempotent — detect returns false after apply', () => {
    const { ctx } = makeCtx({
      base: {
        delivery: {
          deliverRunner: { concurrencyCap: 3, verifyConcurrencyCap: 4 },
        },
      },
      local: { delivery: { deliverRunner: { verifyConcurrencyCap: 8 } } },
    });
    retireVerifyConcurrencyCap.apply(ctx);
    assert.equal(retireVerifyConcurrencyCap.detect(ctx), false);
    assert.doesNotThrow(() => retireVerifyConcurrencyCap.apply(ctx));
  });

  it('is a no-op when no config exists on disk', () => {
    const { ctx } = makeCtx({});
    assert.doesNotThrow(() => retireVerifyConcurrencyCap.apply(ctx));
  });
});
