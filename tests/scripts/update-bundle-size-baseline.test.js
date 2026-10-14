/**
 * update-bundle-size-baseline.test.js — Story #5672.
 *
 * The bundle-size gate had a kind module and a checker but no way to
 * generate its baseline. Pins the refresh end to end against a temp repo:
 *
 *   - one row per declared bundle, raw + gzipped KB summed over every file
 *     its `path` (literal or glob) matches;
 *   - `check-baselines --gate bundle-size` loads and evaluates the result;
 *   - a declared bundle matching no file fails the refresh and writes nothing;
 *   - growth over 1 KB is recorded (the epsilon is KB, not bytes);
 *   - `--help` prints usage and writes nothing.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { makeTempDir } from '../../.agents/scripts/lib/test-temp.js';

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);
const SCRIPTS = path.join(REPO_ROOT, '.agents', 'scripts');

const BUNDLES = [
  { name: 'app', path: 'dist/app.js', limit: '200 kB' },
  { name: 'chunks', path: 'dist/chunks/*.js', limit: '500 kB' },
];

function kb(bytes) {
  return Number((bytes / 1024).toFixed(2));
}

function run(cwd, script, args = []) {
  return spawnSync(process.execPath, [path.join(SCRIPTS, script), ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
  });
}

describe('update-bundle-size-baseline.js', () => {
  let root;
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  function seed(bundles = BUNDLES) {
    root = makeTempDir('bundle-size-refresh-');
    mkdirSync(path.join(root, 'dist', 'chunks'), { recursive: true });
    writeFileSync(
      path.join(root, '.agentrc.json'),
      JSON.stringify({
        project: {
          baseBranch: 'main',
          paths: { agentRoot: '.agents', docsRoot: 'docs', tempRoot: 'temp' },
        },
        delivery: {
          quality: {
            gates: {
              'bundle-size': {
                enabled: true,
                baselinePath: 'baselines/bundle-size.json',
                bundles,
              },
            },
          },
        },
      }),
    );
  }

  function writeArtifact(rel, content) {
    writeFileSync(path.join(root, rel), content);
    return Buffer.from(content);
  }

  function readBaseline() {
    return JSON.parse(
      readFileSync(path.join(root, 'baselines', 'bundle-size.json'), 'utf8'),
    );
  }

  it('writes one row per declared bundle that check-baselines evaluates', () => {
    seed();
    const app = writeArtifact('dist/app.js', 'const a = 1;\n'.repeat(400));
    const c1 = writeArtifact(
      'dist/chunks/one.js',
      'export const one = 1;\n'.repeat(90),
    );
    const c2 = writeArtifact(
      'dist/chunks/two.js',
      'export const two = 2;\n'.repeat(70),
    );
    writeArtifact('dist/chunks/skip.css', 'body {}\n');

    const res = run(root, 'update-bundle-size-baseline.js');
    assert.equal(res.status, 0, `${res.stdout}${res.stderr}`);

    const chunkGz = gzipSync(c1).length + gzipSync(c2).length;
    assert.deepEqual(readBaseline().rows, [
      {
        bundle: 'app',
        rawKb: kb(app.length),
        gzippedKb: kb(gzipSync(app).length),
      },
      {
        bundle: 'chunks',
        rawKb: kb(c1.length + c2.length),
        gzippedKb: kb(chunkGz),
      },
    ]);

    const check = run(root, 'check-baselines.js', [
      '--gate',
      'bundle-size',
      '--no-friction',
    ]);
    assert.equal(check.status, 0, `${check.stdout}${check.stderr}`);
    const report = JSON.parse(check.stdout.slice(check.stdout.indexOf('{')));
    assert.deepEqual(report.schemaErrors, []);
    assert.equal(report.gates[0].kind, 'bundle-size');
  });

  it('fails without writing when a declared bundle matches no file', () => {
    seed();
    writeArtifact('dist/app.js', 'const a = 1;\n');
    const res = run(root, 'update-bundle-size-baseline.js');
    assert.equal(res.status, 1);
    assert.match(`${res.stdout}${res.stderr}`, /"chunks" matches no file/);
    assert.equal(
      existsSync(path.join(root, 'baselines', 'bundle-size.json')),
      false,
    );
  });

  it('records growth over 1 KB rather than folding it into the prior row', () => {
    seed([BUNDLES[0]]);
    writeArtifact('dist/app.js', 'x'.repeat(10 * 1024));
    assert.equal(run(root, 'update-bundle-size-baseline.js').status, 0);
    assert.equal(readBaseline().rows[0].rawKb, 10);

    writeArtifact('dist/app.js', 'x'.repeat(12 * 1024));
    assert.equal(run(root, 'update-bundle-size-baseline.js').status, 0);
    assert.equal(readBaseline().rows[0].rawKb, 12);
  });

  it('--help prints usage and writes nothing', () => {
    seed();
    const res = run(root, 'update-bundle-size-baseline.js', ['--help']);
    assert.equal(res.status, 0);
    assert.match(res.stdout, /update-bundle-size-baseline\.js/);
    assert.equal(existsSync(path.join(root, 'baselines')), false);
  });
});
