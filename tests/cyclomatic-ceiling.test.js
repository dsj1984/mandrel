// tests/cyclomatic-ceiling.test.js
//
// Story #4923 — `delivery.quality.codingGuardrails.cyclomaticMustFix` shipped
// schema-validated, bootstrap-defaulted and resolver-resolved, and was then
// read by nothing: `.agents/workflows/helpers/code-quality-guardrails.md`
// promised "the close-validation chain refuses the merge" over a value with no
// consumer. `check-cyclomatic.js` is that consumer.
//
// Story #5313 retired the config key: the enforced ceiling is the fixed
// `CYCLOMATIC_CEILING` (12), so a consumer cannot bound this gate by tuning a
// number. The assertions below pin that a c=13 function fails the gate, a
// c=12 one passes, and a leftover `cyclomaticMustFix` in a config tunes
// nothing.

import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { after, describe, test } from 'node:test';

import { runCli } from '../.agents/scripts/check-cyclomatic.js';
import {
  buildCyclomaticEnvelope,
  CYCLOMATIC_CEILING,
  diffCyclomaticRows,
  renderCyclomaticDiff,
  resolveCyclomaticPolicy,
  scanCyclomatic,
} from '../.agents/scripts/lib/cyclomatic-ceiling.js';
import { makeTempDir } from '../.agents/scripts/lib/test-temp.js';

const created = [];
after(() => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true });
});

/**
 * A function whose cyclomatic complexity is `branches + 1` — one decision
 * point per `if`. Written as source text so the escomplex kernel scores it
 * for real rather than the test asserting against a hand-made report.
 */
function branchySource(name, branches) {
  const body = Array.from(
    { length: branches },
    (_, i) => `  if (n === ${i}) return ${i};`,
  ).join('\n');
  return `export function ${name}(n) {\n${body}\n  return -1;\n}\n`;
}

function fixtureRepo({ files }) {
  const root = makeTempDir('cyclomatic-');
  created.push(root);
  mkdirSync(path.join(root, 'src'), { recursive: true });
  writeFileSync(
    path.join(root, '.agentrc.json'),
    JSON.stringify(
      {
        project: {
          paths: { agentRoot: '.agents', docsRoot: 'docs', tempRoot: 'temp' },
        },
        github: { owner: 'x', repo: 'y', operatorHandle: '@ci' },
        delivery: {
          quality: {
            gates: { maintainability: { targetDirs: ['src'] } },
          },
        },
      },
      null,
      2,
    ),
  );
  for (const [name, source] of Object.entries(files)) {
    writeFileSync(path.join(root, 'src', name), source);
  }
  return root;
}

function captureRun(root, argv) {
  const out = [];
  const err = [];
  return runCli({
    argv,
    cwd: root,
    stdout: { write: (s) => out.push(s) },
    stderr: { write: (s) => err.push(s) },
  }).then((exitCode) => ({
    exitCode,
    stdout: out.join(''),
    stderr: err.join(''),
  }));
}

describe('resolveCyclomaticPolicy', () => {
  test('reads the advisory flag from the guardrails and the fixed ceiling (Story #5313)', () => {
    const policy = resolveCyclomaticPolicy({
      codingGuardrails: { cyclomaticMustFix: 5, cyclomaticFlag: 3 },
      maintainability: { targetDirs: ['src'], ignoreGlobs: ['src/gen/**'] },
    });
    assert.equal(policy.mustFix, CYCLOMATIC_CEILING);
    assert.equal(
      policy.mustFix,
      12,
      'a leftover cyclomaticMustFix tunes nothing',
    );
    assert.equal(policy.flag, 3);
    assert.deepEqual(policy.targetDirs, ['src']);
    assert.deepEqual(policy.ignoreGlobs, ['src/gen/**']);
  });

  test('falls back to the framework defaults when the block is absent', () => {
    const policy = resolveCyclomaticPolicy({});
    assert.equal(policy.mustFix, 12);
    assert.equal(policy.flag, 8);
    assert.deepEqual(policy.targetDirs, []);
  });
});

describe('the per-file breach row', () => {
  // Reached through `scanCyclomatic`'s `scoreFile` seam rather than a direct
  // export: an export whose only importer is a test is exactly what the
  // `--production` dead-export ratchet exists to catch.
  const scanWith = (methods, ceiling) => {
    const root = fixtureRepo({ files: { 'a.js': 'export const a = 1;\n' } });
    return scanCyclomatic({
      targetDirs: ['src'],
      ceiling,
      cwd: root,
      scoreFile: () => ({ methods, parseError: false }),
    }).rows;
  };

  test('counts only methods strictly above the ceiling', () => {
    const rows = scanWith(
      [{ cyclomatic: 12 }, { cyclomatic: 13 }, { cyclomatic: 19 }],
      12,
    );
    assert.deepEqual(rows, [
      { file: 'src/a.js', methodsAboveCeiling: 2, maxCyclomatic: 19 },
    ]);
  });

  test('emits no row when nothing breaches', () => {
    assert.deepEqual(scanWith([{ cyclomatic: 12 }], 12), []);
  });
});

describe('diffCyclomaticRows', () => {
  const base = [{ file: 'a.js', methodsAboveCeiling: 1, maxCyclomatic: 14 }];

  test('a file gaining an over-ceiling function is `added`', () => {
    const diff = diffCyclomaticRows(base, [
      { file: 'a.js', methodsAboveCeiling: 2, maxCyclomatic: 14 },
    ]);
    assert.equal(diff.added.length, 1);
    assert.equal(diff.added[0].baselineCount, 1);
  });

  test('a brand-new breaching file is `added`', () => {
    const diff = diffCyclomaticRows(base, [
      ...base,
      { file: 'b.js', methodsAboveCeiling: 1, maxCyclomatic: 30 },
    ]);
    assert.deepEqual(
      diff.added.map((r) => r.file),
      ['b.js'],
    );
  });

  test('a worse worst-function at the same count is `worsened`', () => {
    const diff = diffCyclomaticRows(base, [
      { file: 'a.js', methodsAboveCeiling: 1, maxCyclomatic: 21 },
    ]);
    assert.equal(diff.worsened.length, 1);
    assert.equal(diff.worsened[0].baselineMax, 14);
  });

  test('shrinking is `improved`, disappearing is `removed` — neither fails', () => {
    const improved = diffCyclomaticRows(base, [
      { file: 'a.js', methodsAboveCeiling: 1, maxCyclomatic: 13 },
    ]);
    assert.equal(improved.improved.length, 1);
    assert.equal(improved.added.length + improved.worsened.length, 0);

    const removed = diffCyclomaticRows(base, []);
    assert.deepEqual(
      removed.removed.map((r) => r.file),
      ['a.js'],
    );
    assert.equal(removed.added.length + removed.worsened.length, 0);
  });
});

describe('buildCyclomaticEnvelope', () => {
  test('derives the rollup from the rows rather than restating it', () => {
    const env = buildCyclomaticEnvelope({
      rows: [
        { file: 'a.js', methodsAboveCeiling: 2, maxCyclomatic: 14 },
        { file: 'b.js', methodsAboveCeiling: 1, maxCyclomatic: 30 },
      ],
      ceiling: 12,
      generatedAt: '2026-01-01T00:00:00.000Z',
    });
    assert.deepEqual(env.rollup['*'], {
      filesAboveCeiling: 2,
      methodsAboveCeiling: 3,
      maxCyclomatic: 30,
    });
    assert.equal(env.ceiling, 12);
  });
});

describe('scanCyclomatic scores real source through the escomplex kernel', () => {
  test('a c=4 function breaches a ceiling of 3 and clears a ceiling of 12', () => {
    const root = fixtureRepo({
      files: { 'branchy.js': branchySource('branchy', 3) },
    });
    const strict = scanCyclomatic({
      targetDirs: ['src'],
      ceiling: 3,
      cwd: root,
    });
    assert.deepEqual(
      strict.rows.map((r) => r.file),
      ['src/branchy.js'],
    );
    assert.equal(strict.rows[0].maxCyclomatic, 4);

    const lenient = scanCyclomatic({
      targetDirs: ['src'],
      ceiling: 12,
      cwd: root,
    });
    assert.deepEqual(lenient.rows, []);
  });

  test('an unparseable file is counted, never silently scored as clean', () => {
    const root = fixtureRepo({ files: { 'broken.js': 'export function (' } });
    const scan = scanCyclomatic({
      targetDirs: ['src'],
      ceiling: 1,
      cwd: root,
    });
    assert.equal(scan.parseErrors, 1);
    assert.deepEqual(scan.rows, []);
  });
});

describe('renderCyclomaticDiff', () => {
  test('names every bucket and marks only added/worsened as a failure', () => {
    const failing = renderCyclomaticDiff(
      {
        added: [
          {
            file: 'a.js',
            methodsAboveCeiling: 2,
            maxCyclomatic: 14,
            baselineCount: 1,
          },
        ],
        worsened: [
          {
            file: 'b.js',
            methodsAboveCeiling: 1,
            maxCyclomatic: 21,
            baselineMax: 14,
          },
        ],
        improved: [
          {
            file: 'c.js',
            methodsAboveCeiling: 1,
            maxCyclomatic: 13,
            baselineCount: 2,
            baselineMax: 20,
          },
        ],
        removed: [{ file: 'd.js', methodsAboveCeiling: 1, maxCyclomatic: 13 }],
      },
      12,
    );
    assert.match(failing, /\+ a\.js/);
    assert.match(failing, /! b\.js/);
    assert.match(failing, /~ c\.js/);
    assert.match(failing, /- d\.js/);
    assert.match(failing, /gate fail/);

    const clean = renderCyclomaticDiff(
      { added: [], worsened: [], improved: [], removed: [] },
      12,
    );
    assert.match(clean, /\(ok\)/);
  });
});

describe('check-cyclomatic.js enforces the fixed ceiling of 12', () => {
  test('a function over the ceiling fails the gate', async () => {
    const root = fixtureRepo({
      files: { 'branchy.js': branchySource('branchy', 12) },
    });
    const res = await captureRun(root, []);
    assert.equal(
      res.exitCode,
      1,
      `expected the ratchet to fail; stdout was:\n${res.stdout}`,
    );
    assert.match(res.stdout, /\+ src\/branchy\.js/);
    assert.match(res.stdout, /gate fail/);
  });

  test('a function at the ceiling passes, and a leftover config key cannot lower it', async () => {
    const root = fixtureRepo({
      files: { 'branchy.js': branchySource('branchy', 11) },
    });
    const res = await captureRun(root, []);
    assert.equal(res.exitCode, 0, res.stdout);
    assert.match(res.stdout, /ceiling=12/);
  });

  test('--update records the existing breaches, after which the gate is green', async () => {
    const root = fixtureRepo({
      files: { 'branchy.js': branchySource('branchy', 12) },
    });
    mkdirSync(path.join(root, 'baselines'), { recursive: true });
    const updated = await captureRun(root, ['--update']);
    assert.equal(updated.exitCode, 0, updated.stderr);

    const written = JSON.parse(
      readFileSync(path.join(root, 'baselines', 'cyclomatic.json'), 'utf8'),
    );
    assert.equal(written.ceiling, 12);
    assert.equal(written.rollup['*'].methodsAboveCeiling, 1);

    const after = await captureRun(root, []);
    assert.equal(after.exitCode, 0, after.stdout);
  });

  test('a NEW over-ceiling function still fails once the pre-existing ones are baselined', async () => {
    const root = fixtureRepo({
      files: { 'branchy.js': branchySource('branchy', 12) },
    });
    mkdirSync(path.join(root, 'baselines'), { recursive: true });
    await captureRun(root, ['--update']);

    // The "new or changed code" case the AC names: the baselined breach is
    // forgiven, the one this change introduces is not.
    writeFileSync(
      path.join(root, 'src', 'added.js'),
      branchySource('addedLater', 14),
    );
    const res = await captureRun(root, []);
    assert.equal(res.exitCode, 1, res.stdout);
    assert.match(res.stdout, /\+ src\/added\.js/);
    assert.doesNotMatch(res.stdout, /\+ src\/branchy\.js/);
  });

  test('a baseline recorded at another ceiling is called out, not trusted silently', async () => {
    const root = fixtureRepo({
      files: { 'branchy.js': branchySource('branchy', 12) },
    });
    mkdirSync(path.join(root, 'baselines'), { recursive: true });
    writeFileSync(
      path.join(root, 'baselines', 'cyclomatic.json'),
      JSON.stringify({
        ceiling: 99,
        rows: [
          { file: 'src/branchy.js', methodsAboveCeiling: 1, maxCyclomatic: 13 },
        ],
      }),
    );
    const res = await captureRun(root, []);
    assert.match(res.stderr, /recorded at ceiling c=99/);
  });

  test('a missing baseline is announced, then treated as empty', async () => {
    const root = fixtureRepo({
      files: { 'branchy.js': branchySource('branchy', 12) },
    });
    const res = await captureRun(root, []);
    assert.match(res.stderr, /baseline not found/);
    assert.equal(res.exitCode, 1);
  });

  test('--json reports the fixed ceiling alongside the verdict', async () => {
    const root = fixtureRepo({
      files: { 'branchy.js': branchySource('branchy', 12) },
    });
    const res = await captureRun(root, ['--json']);
    const envelope = JSON.parse(res.stdout);
    assert.equal(envelope.kind, 'cyclomatic-report');
    assert.equal(envelope.ceiling, 12);
    assert.equal(envelope.exitCode, 1);
    assert.equal(envelope.added.length, 1);
  });
});
