/**
 * refresh-service.coverage-artifact.test.js — Story #5672.
 *
 * The coverage and CRAP refreshes both read the one Istanbul per-file
 * artifact the capture contract names (`coverage.coveragePath`). Pins:
 *
 *   - the default coverage scorer reads the CONFIGURED path, not a hardcoded
 *     `coverage/coverage-final.json`;
 *   - both refreshes complete from a fixture artifact at that path;
 *   - a refresh with no artifact, full-scope or scoped, fails naming the
 *     `json` reporter contract instead of returning zero rows.
 *
 * Config resolution is cached per cwd, so every case gets its own workDir.
 */

import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import {
  fileFilterFor,
  refreshBaseline,
  resolveDefaultScorer,
} from '../../.agents/scripts/lib/baselines/refresh-service.js';
import { makeTempDir } from '../../.agents/scripts/lib/test-temp.js';

const COVERAGE_PATH = 'out/final.json';
const SOURCE = 'export function add(a, b) {\n  return a + b;\n}\n';

function seedRepo({ withArtifact }) {
  const workDir = makeTempDir('refresh-coverage-artifact-');
  mkdirSync(path.join(workDir, 'src'), { recursive: true });
  const abs = path.join(workDir, 'src', 'a.js');
  writeFileSync(abs, SOURCE);
  writeFileSync(
    path.join(workDir, '.agentrc.json'),
    JSON.stringify({
      project: {
        paths: {
          agentRoot: '.agents',
          docsRoot: 'docs',
          tempRoot: path.join(workDir, 'temp'),
        },
      },
      delivery: {
        quality: {
          gates: {
            coverage: { coveragePath: COVERAGE_PATH },
            crap: { targetDirs: ['src'] },
          },
        },
      },
    }),
  );
  if (withArtifact) {
    mkdirSync(path.join(workDir, 'out'), { recursive: true });
    const loc = (line, start, end) => ({
      start: { line, column: start },
      end: { line, column: end },
    });
    writeFileSync(
      path.join(workDir, COVERAGE_PATH),
      JSON.stringify({
        [abs]: {
          path: abs,
          statementMap: { 0: loc(2, 2, 15) },
          s: { 0: 1 },
          fnMap: {
            0: {
              name: 'add',
              decl: loc(1, 16, 19),
              loc: {
                start: { line: 1, column: 26 },
                end: { line: 3, column: 1 },
              },
              line: 1,
            },
          },
          f: { 0: 1 },
          branchMap: {},
          b: {},
        },
      }),
    );
  }
  return workDir;
}

describe('coverage + CRAP refresh from the configured artifact (Story #5672)', () => {
  let workDir;
  afterEach(() => {
    if (workDir) rmSync(workDir, { recursive: true, force: true });
    workDir = undefined;
  });

  it('the coverage refresh reads the configured coveragePath and writes its rows', async () => {
    workDir = seedRepo({ withArtifact: true });
    const writePath = path.join(workDir, 'baselines', 'coverage.json');
    await refreshBaseline({
      kind: 'coverage',
      cwd: workDir,
      fullScope: true,
      writePath,
      scorer: resolveDefaultScorer('coverage', { cwd: workDir }),
    });
    const written = JSON.parse(readFileSync(writePath, 'utf8'));
    assert.deepEqual(
      written.rows.map((r) => r.path),
      ['src/a.js'],
    );
    assert.equal(written.rows[0].lines, 100);
  });

  it('the CRAP refresh completes from the same artifact', async () => {
    workDir = seedRepo({ withArtifact: true });
    const scorer = resolveDefaultScorer('crap', { cwd: workDir });
    const rows = await scorer([], { cwd: workDir, fullScope: true });
    assert.ok(rows.length > 0, 'the CRAP join must score the covered method');
    assert.deepEqual(
      rows.map((r) => [r.file, r.method]),
      [['src/a.js', 'add']],
    );
  });

  it('a full-scope coverage refresh with no artifact fails naming the contract', async () => {
    workDir = seedRepo({ withArtifact: false });
    const scorer = resolveDefaultScorer('coverage', { cwd: workDir });
    assert.throws(
      () => scorer([], { cwd: workDir, fullScope: true }),
      /coverage artifact not found at .*out[\\/]final\.json.*`json` reporter/,
    );
  });

  it('a full-scope CRAP refresh with no artifact fails naming the contract', async () => {
    workDir = seedRepo({ withArtifact: false });
    const scorer = resolveDefaultScorer('crap', { cwd: workDir });
    await assert.rejects(
      scorer([], { cwd: workDir, fullScope: true }),
      /coverage artifact not found.*`json` reporter/,
    );
  });

  it('a scoped refresh with no artifact throws instead of yielding no rows (Story #5683)', async () => {
    workDir = seedRepo({ withArtifact: false });
    const opts = { cwd: workDir, fullScope: false };
    const named = (err) =>
      err.name === 'MissingCoverageArtifactError' &&
      /coverage artifact not found/.test(err.message);
    assert.throws(
      () =>
        resolveDefaultScorer('coverage', { cwd: workDir })(['src/a.js'], opts),
      named,
    );
    await assert.rejects(
      resolveDefaultScorer('crap', { cwd: workDir })(['src/a.js'], opts),
      named,
    );
  });
});

describe('bundle-size in the refresh service (Story #5672)', () => {
  it('no changed file scopes a bundle row: bundle names are not paths', () => {
    const predicate = fileFilterFor('bundle-size');
    assert.equal(predicate('dist/app.js'), false);
  });

  it('writes name-keyed rows without path canonicalisation', async () => {
    const dir = makeTempDir('refresh-bundle-size-');
    try {
      const writePath = path.join(dir, 'bundle-size.json');
      await refreshBaseline({
        kind: 'bundle-size',
        cwd: dir,
        fullScope: true,
        writePath,
        scorer: () => [{ bundle: 'app', rawKb: 10, gzippedKb: 3 }],
      });
      assert.deepEqual(JSON.parse(readFileSync(writePath, 'utf8')).rows, [
        { bundle: 'app', rawKb: 10, gzippedKb: 3 },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
