// lib/migrations/steps/__tests__/2.11.0-retire-max-seed-words.test.js
/**
 * Unit tests for the Story #4722 follow-up migration step — strips the
 * retired `planning.complexityGate.maxSeedWords` knob from a consumer
 * `.agentrc.json`. All tests drive `detect`/`apply` against an in-memory
 * fake fs (testing-standards § Unit) — no real filesystem I/O.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';

import { retireMaxSeedWords } from '../2.11.0-retire-max-seed-words.js';

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

describe('retireMaxSeedWords — detect', () => {
  it('detects a config carrying maxSeedWords', () => {
    const { ctx } = makeCtx({
      planning: { complexityGate: { maxSeedWords: 200 } },
    });
    assert.equal(retireMaxSeedWords.detect(ctx), true);
  });

  it('does not detect a clean complexityGate', () => {
    const { ctx } = makeCtx({
      planning: { complexityGate: { enabled: true, maxArtifacts: 1 } },
    });
    assert.equal(retireMaxSeedWords.detect(ctx), false);
  });

  it('does not detect when .agentrc.json is absent', () => {
    const { ctx } = makeCtx(null);
    assert.equal(retireMaxSeedWords.detect(ctx), false);
  });
});

describe('retireMaxSeedWords — apply', () => {
  it('strips the retired key and preserves sibling keys', () => {
    const { ctx, readConfig } = makeCtx({
      planning: {
        complexityGate: { maxSeedWords: 200, enabled: true, maxArtifacts: 2 },
        riskHeuristics: ['payment flow'],
      },
    });

    retireMaxSeedWords.apply(ctx);

    const written = readConfig();
    assert.equal(written.planning.complexityGate.maxSeedWords, undefined);
    assert.equal(written.planning.complexityGate.enabled, true);
    assert.equal(written.planning.complexityGate.maxArtifacts, 2);
    assert.deepEqual(written.planning.riskHeuristics, ['payment flow']);
  });

  it('removes an emptied complexityGate — and an emptied planning block', () => {
    const { ctx, readConfig } = makeCtx({
      project: { paths: { agentRoot: '.agents' } },
      planning: { complexityGate: { maxSeedWords: 200 } },
    });

    retireMaxSeedWords.apply(ctx);

    const written = readConfig();
    assert.equal('planning' in written, false);
    assert.deepEqual(written.project, { paths: { agentRoot: '.agents' } });
  });

  it('keeps a planning block that still has other keys', () => {
    const { ctx, readConfig } = makeCtx({
      planning: {
        complexityGate: { maxSeedWords: 200 },
        riskHeuristics: ['schema migration'],
      },
    });

    retireMaxSeedWords.apply(ctx);

    const written = readConfig();
    assert.equal('complexityGate' in written.planning, false);
    assert.deepEqual(written.planning.riskHeuristics, ['schema migration']);
  });

  it('is a no-op when .agentrc.json is absent', () => {
    const { ctx } = makeCtx(null);
    assert.doesNotThrow(() => retireMaxSeedWords.apply(ctx));
  });

  it('satisfies the idempotency contract: detect is false after apply', () => {
    const { ctx } = makeCtx({
      planning: { complexityGate: { maxSeedWords: 200 } },
    });

    assert.equal(retireMaxSeedWords.detect(ctx), true);
    retireMaxSeedWords.apply(ctx);
    assert.equal(retireMaxSeedWords.detect(ctx), false);

    // A second apply must not throw or change anything further.
    assert.doesNotThrow(() => retireMaxSeedWords.apply(ctx));
    assert.equal(retireMaxSeedWords.detect(ctx), false);
  });
});
