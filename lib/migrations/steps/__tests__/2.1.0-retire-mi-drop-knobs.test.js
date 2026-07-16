// lib/migrations/steps/__tests__/2.1.0-retire-mi-drop-knobs.test.js
/**
 * Unit tests for the Story #4531 migration step — strips the retired
 * `delivery.quality.codingGuardrails.miDropMustRefactor` and
 * `delivery.quality.autoRefresh.miDropCap` keys from a consumer
 * `.agentrc.json`. All tests drive `detect`/`apply` against an in-memory
 * fake fs (testing-standards § Unit) — no real filesystem I/O.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';

import { retireMiDropKnobs } from '../2.1.0-retire-mi-drop-knobs.js';

const PROJECT_ROOT = '/consumer';
const AGENTRC_PATH = path.join(PROJECT_ROOT, '.agentrc.json');

/**
 * @param {object | null} initialConfig - `null` means no file on disk.
 * @returns {{ ctx: object, readConfig: () => object }}
 */
function makeCtx(initialConfig) {
  const files = new Map();
  if (initialConfig !== null) {
    files.set(AGENTRC_PATH, JSON.stringify(initialConfig, null, 2));
  }

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
    readConfig: () => JSON.parse(files.get(AGENTRC_PATH)),
  };
}

describe('retireMiDropKnobs — detect', () => {
  it('detects a config carrying miDropMustRefactor', () => {
    const { ctx } = makeCtx({
      delivery: { quality: { codingGuardrails: { miDropMustRefactor: 1.5 } } },
    });
    assert.equal(retireMiDropKnobs.detect(ctx), true);
  });

  it('detects a config carrying miDropCap', () => {
    const { ctx } = makeCtx({
      delivery: { quality: { autoRefresh: { miDropCap: 1.5 } } },
    });
    assert.equal(retireMiDropKnobs.detect(ctx), true);
  });

  it('does not detect a clean config', () => {
    const { ctx } = makeCtx({
      delivery: {
        quality: {
          codingGuardrails: { cyclomaticFlag: 8 },
          autoRefresh: { enabled: true },
        },
      },
    });
    assert.equal(retireMiDropKnobs.detect(ctx), false);
  });

  it('does not detect when .agentrc.json is absent', () => {
    const { ctx } = makeCtx(null);
    assert.equal(retireMiDropKnobs.detect(ctx), false);
  });
});

describe('retireMiDropKnobs — apply', () => {
  it('strips both retired keys and preserves sibling keys', () => {
    const { ctx, readConfig } = makeCtx({
      delivery: {
        quality: {
          codingGuardrails: { miDropMustRefactor: 1.5, cyclomaticFlag: 8 },
          autoRefresh: { miDropCap: 1.5, enabled: true },
          gates: { crap: { floors: { '*': { max: 30 } } } },
        },
      },
    });

    retireMiDropKnobs.apply(ctx);

    const written = readConfig();
    assert.equal(
      written.delivery.quality.codingGuardrails.miDropMustRefactor,
      undefined,
    );
    assert.equal(written.delivery.quality.codingGuardrails.cyclomaticFlag, 8);
    assert.equal(written.delivery.quality.autoRefresh.miDropCap, undefined);
    assert.equal(written.delivery.quality.autoRefresh.enabled, true);
    assert.deepEqual(written.delivery.quality.gates, {
      crap: { floors: { '*': { max: 30 } } },
    });
  });

  it('removes an emptied parent object entirely', () => {
    const { ctx, readConfig } = makeCtx({
      delivery: {
        quality: {
          codingGuardrails: { miDropMustRefactor: 1.5 },
          autoRefresh: { miDropCap: 1.5 },
        },
      },
    });

    retireMiDropKnobs.apply(ctx);

    const written = readConfig();
    assert.equal('codingGuardrails' in written.delivery.quality, false);
    assert.equal('autoRefresh' in written.delivery.quality, false);
  });

  it('is a no-op when .agentrc.json is absent', () => {
    const { ctx } = makeCtx(null);
    assert.doesNotThrow(() => retireMiDropKnobs.apply(ctx));
  });

  it('satisfies the idempotency contract: detect is false after apply', () => {
    const { ctx } = makeCtx({
      delivery: {
        quality: {
          codingGuardrails: { miDropMustRefactor: 1.5 },
          autoRefresh: { miDropCap: 1.5 },
        },
      },
    });

    assert.equal(retireMiDropKnobs.detect(ctx), true);
    retireMiDropKnobs.apply(ctx);
    assert.equal(retireMiDropKnobs.detect(ctx), false);

    // A second apply must not throw or change anything further.
    assert.doesNotThrow(() => retireMiDropKnobs.apply(ctx));
    assert.equal(retireMiDropKnobs.detect(ctx), false);
  });
});
