/**
 * baseline-refresh-missing-artifact.integration.test.js — Story #5683.
 *
 * Drives the real `update-coverage-baseline.js` and `update-crap-baseline.js`
 * CLIs on a scoped (`--diff-scope`) refresh in a throwaway git repo that has a
 * committed prior baseline and NO coverage artifact. Both must exit non-zero
 * and leave the prior baseline byte-identical.
 *
 * Why it is a real-CLI test: the scope merge takes in-scope rows only from the
 * regenerated set, so a scorer that answers "no artifact" with an empty row
 * set deletes the changed file's rows at exit 0. Removing the refusal from
 * either scorer turns these cases red — the row for `src/a.js` disappears and
 * the CLI exits 0.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { makeTempDir } from '../../.agents/scripts/lib/test-temp.js';

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);
const SCRIPTS = path.join(REPO_ROOT, '.agents', 'scripts');

// Every `GIT_*` variable dropped: under a husky hook from a linked worktree,
// GIT_DIR points at the shared main gitdir and a fixture `git init` would
// write into the MAIN checkout's config (#4580).
const CLEAN_ENV = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')),
);

const COVERAGE_BASELINE = 'baselines/coverage.json';
const CRAP_BASELINE = 'baselines/crap.json';

function envelope(kind, extra, rows) {
  return `${JSON.stringify(
    {
      $schema: `.agents/schemas/baselines/${kind}.schema.json`,
      ...extra,
      rows,
    },
    null,
    2,
  )}\n`;
}

const PRIOR = Object.freeze({
  [COVERAGE_BASELINE]: envelope('coverage', { kernelVersion: '1.0.0' }, [
    { path: 'src/a.js', lines: 100, branches: 100, functions: 100 },
    { path: 'src/b.js', lines: 80, branches: 50, functions: 100 },
  ]),
  [CRAP_BASELINE]: envelope('crap', { kernelVersion: '0.1.0' }, [
    { path: 'src/a.js', method: 'add', startLine: 1, crap: 1 },
    { path: 'src/b.js', method: 'sub', startLine: 1, crap: 1 },
  ]),
});

/**
 * A repo whose `main` carries both baselines and whose checked-out branch
 * changes `src/a.js`, so `--diff-scope main` puts `src/a.js` in scope.
 */
function seedRepo() {
  const dir = makeTempDir('baseline-missing-artifact-');
  const git = (...args) => {
    const res = spawnSync('git', args, {
      cwd: dir,
      encoding: 'utf8',
      env: CLEAN_ENV,
    });
    assert.equal(res.status, 0, `git ${args.join(' ')}: ${res.stderr}`);
  };
  mkdirSync(path.join(dir, 'src'), { recursive: true });
  mkdirSync(path.join(dir, 'baselines'), { recursive: true });
  writeFileSync(
    path.join(dir, '.agentrc.json'),
    JSON.stringify({
      project: {
        paths: {
          agentRoot: '.agents',
          docsRoot: 'docs',
          tempRoot: path.join(dir, 'temp'),
        },
      },
      delivery: {
        quality: {
          gates: {
            coverage: { coveragePath: 'coverage/coverage-final.json' },
            crap: { targetDirs: ['src'] },
          },
        },
      },
    }),
  );
  writeFileSync(
    path.join(dir, 'src', 'a.js'),
    'export function add(a, b) {\n  return a + b;\n}\n',
  );
  writeFileSync(
    path.join(dir, 'src', 'b.js'),
    'export function sub(a, b) {\n  return a - b;\n}\n',
  );
  for (const [rel, body] of Object.entries(PRIOR)) {
    writeFileSync(path.join(dir, rel), body);
  }
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'fixture@example.invalid');
  git('config', 'user.name', 'fixture');
  git('config', 'commit.gpgsign', 'false');
  git('add', '-A');
  git('commit', '-q', '-m', 'seed');
  git('checkout', '-q', '-b', 'story-1');
  writeFileSync(
    path.join(dir, 'src', 'a.js'),
    'export function add(a, b) {\n  return b + a;\n}\n',
  );
  git('commit', '-q', '-am', 'change a');
  return dir;
}

function runCli(script, cwd) {
  return spawnSync(
    process.execPath,
    [path.join(SCRIPTS, script), '--diff-scope', 'main'],
    { cwd, encoding: 'utf8', env: CLEAN_ENV },
  );
}

describe('scoped baseline refresh with no coverage artifact (Story #5683)', () => {
  let dir;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  for (const [script, baseline] of [
    ['update-coverage-baseline.js', COVERAGE_BASELINE],
    ['update-crap-baseline.js', CRAP_BASELINE],
  ]) {
    it(`${script} exits non-zero and leaves ${baseline} byte-identical`, () => {
      dir = seedRepo();
      const res = runCli(script, dir);
      assert.notEqual(
        res.status,
        0,
        `expected a refusal; stdout:\n${res.stdout}\nstderr:\n${res.stderr}`,
      );
      assert.match(
        `${res.stdout}\n${res.stderr}`,
        /coverage artifact not found/,
      );
      assert.equal(
        readFileSync(path.join(dir, baseline), 'utf8'),
        PRIOR[baseline],
      );
    });
  }
});
