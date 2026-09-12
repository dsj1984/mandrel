// lib/migrations/steps/__tests__/2.57.0-retire-planning-limit-knobs.test.js
/**
 * Unit tests for the Story #5312 migration step — strips the ten retired
 * `planning.*` limit knobs from a consumer `.agentrc.json`. All tests drive
 * `detect`/`apply` against an in-memory fake fs (testing-standards § Unit) —
 * no real filesystem I/O.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';

import { retirePlanningLimitKnobs } from '../2.57.0-retire-planning-limit-knobs.js';

const PROJECT_ROOT = '/consumer';
const AGENTRC_PATH = path.join(PROJECT_ROOT, '.agentrc.json');

const RETIRED_TOP_LEVEL = [
  'complexityGate',
  'riskHeuristics',
  'failOnSharedEditors',
  'requireExplicitCrossStoryDeps',
  'failOnRegistryConflicts',
  'failOnLargeFanOut',
  'largeFanOutThreshold',
  'crossCuttingRegistries',
];

/**
 * @param {object | null} initialConfig - `null` means no file on disk.
 * @returns {{ ctx: object, readConfig: () => object, writes: () => number }}
 */
function makeCtx(initialConfig) {
  const files = new Map();
  let writes = 0;
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
      writes += 1;
      files.set(filePath, contents);
    },
  };

  return {
    ctx: { projectRoot: PROJECT_ROOT, fs },
    readConfig: () => JSON.parse(files.get(AGENTRC_PATH)),
    writes: () => writes,
  };
}

function fullyRetiredConfig() {
  return {
    project: { paths: { agentRoot: '.agents' } },
    planning: {
      complexityGate: { enabled: true, maxArtifacts: 1 },
      riskHeuristics: ['Destructive data mutations'],
      failOnSharedEditors: true,
      requireExplicitCrossStoryDeps: true,
      failOnRegistryConflicts: false,
      failOnLargeFanOut: true,
      largeFanOutThreshold: 12,
      crossCuttingRegistries: ['**/listeners/index.js'],
      memoryPool: { staleAfterDays: 45, growthDelta: 10 },
    },
  };
}

describe('retirePlanningLimitKnobs — detect', () => {
  it('detects every retired top-level planning key individually', () => {
    for (const key of RETIRED_TOP_LEVEL) {
      const { ctx } = makeCtx({ planning: { [key]: true } });
      assert.equal(retirePlanningLimitKnobs.detect(ctx), true, key);
    }
  });

  it('detects the two retired memoryPool keys', () => {
    assert.equal(
      retirePlanningLimitKnobs.detect(
        makeCtx({ planning: { memoryPool: { staleAfterDays: 30 } } }).ctx,
      ),
      true,
    );
    assert.equal(
      retirePlanningLimitKnobs.detect(
        makeCtx({ planning: { memoryPool: { growthDelta: 25 } } }).ctx,
      ),
      true,
    );
  });

  it('does not detect a planning block carrying only surviving keys', () => {
    const { ctx } = makeCtx({
      planning: {
        memoryPool: { indexByteCeiling: 24576 },
        navigation: { routeGlobs: ['pages/**'] },
      },
    });
    assert.equal(retirePlanningLimitKnobs.detect(ctx), false);
  });

  it('does not detect an absent planning block or an absent config', () => {
    assert.equal(retirePlanningLimitKnobs.detect(makeCtx({}).ctx), false);
    assert.equal(retirePlanningLimitKnobs.detect(makeCtx(null).ctx), false);
  });
});

describe('retirePlanningLimitKnobs — apply', () => {
  it('strips exactly the ten retired keys and prunes the emptied planning block', () => {
    const { ctx, readConfig } = makeCtx(fullyRetiredConfig());
    retirePlanningLimitKnobs.apply(ctx);
    const config = readConfig();
    assert.equal(Object.hasOwn(config, 'planning'), false);
    assert.deepEqual(config.project, { paths: { agentRoot: '.agents' } });
  });

  it('keeps memoryPool.indexByteCeiling and the navigation block', () => {
    const initial = fullyRetiredConfig();
    initial.planning.memoryPool.indexByteCeiling = 20000;
    initial.planning.navigation = { routeGlobs: ['app/**'] };
    const { ctx, readConfig } = makeCtx(initial);
    retirePlanningLimitKnobs.apply(ctx);
    assert.deepEqual(readConfig().planning, {
      memoryPool: { indexByteCeiling: 20000 },
      navigation: { routeGlobs: ['app/**'] },
    });
  });

  it('is idempotent — a second run detects nothing and writes nothing', () => {
    const { ctx, writes } = makeCtx(fullyRetiredConfig());
    retirePlanningLimitKnobs.apply(ctx);
    const afterFirst = writes();
    assert.equal(retirePlanningLimitKnobs.detect(ctx), false);
    retirePlanningLimitKnobs.apply(ctx);
    assert.equal(writes(), afterFirst);
  });

  it('carries the 2.57.0 version and names the retired surface', () => {
    assert.equal(retirePlanningLimitKnobs.version, '2.57.0');
    assert.match(retirePlanningLimitKnobs.description, /complexityGate/);
    assert.match(retirePlanningLimitKnobs.description, /riskHeuristics/);
  });
});
