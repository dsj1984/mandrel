// lib/migrations/steps/__tests__/2.63.0-baseline-merge-queue-shape.test.js
/**
 * Unit tests for the Story #5400 migration step — strips `generatedAt` and
 * `rollup` from committed row-set baselines. Driven against an in-memory fake
 * fs (testing-standards § Unit).
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';

import { migrations } from '../../index.js';
import { baselineMergeQueueShape } from '../2.63.0-baseline-merge-queue-shape.js';

const PROJECT_ROOT = '/consumer';
const BASELINES = path.join(PROJECT_ROOT, 'baselines');

const serialize = (value) => `${JSON.stringify(value, null, 2)}\n`;

/**
 * @param {Record<string, string>} baselineFiles name → content under baselines/
 */
function makeCtx(baselineFiles) {
  const files = new Map(
    Object.entries(baselineFiles).map(([name, content]) => [
      path.join(BASELINES, name),
      content,
    ]),
  );
  const writes = [];
  const fs = {
    readdirSync(dir) {
      if (dir !== BASELINES) throw new Error(`ENOENT: ${dir}`);
      return [...files.keys()].map((f) => path.basename(f));
    },
    readFileSync(file) {
      if (!files.has(file)) throw new Error(`ENOENT: ${file}`);
      return files.get(file);
    },
    writeFileSync(file, content) {
      writes.push(path.basename(file));
      files.set(file, content);
    },
  };
  return {
    ctx: { projectRoot: PROJECT_ROOT, fs },
    read: (name) => files.get(path.join(BASELINES, name)),
    writes,
  };
}

const OLD_COVERAGE = {
  $schema: '.agents/schemas/baselines/coverage.schema.json',
  kernelVersion: '1.0.0',
  generatedAt: '2026-09-18T19:38:20.219Z',
  rollup: { '*': { lines: 90, branches: 80, functions: 90 } },
  rows: [{ path: 'src/a.js', lines: 90, branches: 80, functions: 90 }],
};

const OLD_CRAP = {
  $schema: '.agents/schemas/baselines/crap.schema.json',
  kernelVersion: '0.1.0',
  generatedAt: '2026-09-18T19:38:21.756Z',
  scoringSemantics: 'method-identity-v3',
  tsTranspilerVersion: '6.0.3',
  provenanceStamped: true,
  rollup: { '*': { p50: 2, p95: 2, max: 2, methodsAbove20: 0 } },
  rows: [{ path: 'src/a.js', method: 'run', startLine: 1, crap: 2 }],
};

const OLD_CYCLOMATIC = {
  $schema: 'https://mandrel.dev/baselines/cyclomatic.schema.json',
  generatedAt: '2026-09-18T15:56:00.369Z',
  ceiling: 12,
  rollup: {
    '*': { filesAboveCeiling: 1, methodsAboveCeiling: 1, maxCyclomatic: 18 },
  },
  rows: [{ file: 'src/a.js', methodsAboveCeiling: 1, maxCyclomatic: 18 }],
};

const OLD_DEAD_EXPORTS = {
  $schema: 'https://mandrel.dev/baselines/dead-exports.schema.json',
  kernelVersion: '6.17.1',
  generatedAt: '2026-09-18T15:56:00.369Z',
  mode: 'production',
  rows: [{ file: 'src/a.js', symbol: 'x' }],
};

const ARCH_CYCLES =
  '{\n  "$schema": "https://mandrel.dev/baselines/arch-cycles.schema.json",\n  "generatedAt": "2026-06-11T00:00:00.000Z",\n  "cycles": []\n}\n';

describe('2.63.0 baseline merge-queue shape migration', () => {
  it('is registered in ascending version order', () => {
    assert.ok(migrations.includes(baselineMergeQueueShape));
    const idx = migrations.indexOf(baselineMergeQueueShape);
    assert.equal(idx, migrations.length - 1);
  });

  it('strips generatedAt and rollup, keeping every other key in order', () => {
    const { ctx, read } = makeCtx({
      'coverage.json': serialize(OLD_COVERAGE),
      'crap.json': serialize(OLD_CRAP),
      'cyclomatic.json': serialize(OLD_CYCLOMATIC),
      'dead-exports-production.json': serialize(OLD_DEAD_EXPORTS),
    });
    assert.equal(baselineMergeQueueShape.detect(ctx), true);
    baselineMergeQueueShape.apply(ctx);

    const { generatedAt: _g, rollup: _r, ...coverage } = OLD_COVERAGE;
    assert.equal(read('coverage.json'), serialize(coverage));
    assert.deepEqual(Object.keys(JSON.parse(read('crap.json'))), [
      '$schema',
      'kernelVersion',
      'scoringSemantics',
      'tsTranspilerVersion',
      'provenanceStamped',
      'rows',
    ]);
    assert.deepEqual(Object.keys(JSON.parse(read('cyclomatic.json'))), [
      '$schema',
      'ceiling',
      'rows',
    ]);
    assert.deepEqual(
      Object.keys(JSON.parse(read('dead-exports-production.json'))),
      ['$schema', 'kernelVersion', 'mode', 'rows'],
    );
  });

  it('is idempotent: a second pass detects nothing and writes nothing', () => {
    const { ctx, writes } = makeCtx({
      'coverage.json': serialize(OLD_COVERAGE),
    });
    baselineMergeQueueShape.apply(ctx);
    assert.equal(baselineMergeQueueShape.detect(ctx), false);
    baselineMergeQueueShape.apply(ctx);
    assert.deepEqual(writes, ['coverage.json']);
  });

  it('leaves out-of-scope and unparseable files byte-identical', () => {
    const { ctx, read, writes } = makeCtx({
      'arch-cycles.json': ARCH_CYCLES,
      'broken.json': '{ not json',
      'agents-loc.csv': 'a,b\n',
    });
    assert.equal(baselineMergeQueueShape.detect(ctx), false);
    baselineMergeQueueShape.apply(ctx);
    assert.deepEqual(writes, []);
    assert.equal(read('arch-cycles.json'), ARCH_CYCLES);
  });

  it('is a no-op when the project has no baselines directory', () => {
    const { ctx } = makeCtx({});
    ctx.projectRoot = '/elsewhere';
    assert.equal(baselineMergeQueueShape.detect(ctx), false);
    assert.doesNotThrow(() => baselineMergeQueueShape.apply(ctx));
  });
});
