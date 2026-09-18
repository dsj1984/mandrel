// tests/check-baselines-pipe-flush.test.js
//
// check-baselines must not truncate its own report when stdout is a pipe.
//
// Story #4783 removed the eager `process.exit()` from `runAsCli`'s shared
// settle path precisely because it terminates before a queued async pipe
// write drains — "any CLI emitting more than 64 KiB into a pipe truncated
// silently". `check-baselines.js` adopted `runAsCli` but kept calling
// `process.exit()` from inside its own `main()`, on both the success arm and
// the EXIT_CONFIG catch arm, which reinstated the defect for the one gate
// whose report is routinely a quarter of a megabyte.
//
// Observed: CI's coverage step is `npm run test:coverage 2>&1 | tee
// test-output.txt`, so the verdict was cut off mid-object in both the Actions
// log and the uploaded artifact, ending on a dangling `"functions": 1` with
// no npm error block — which reads as a crash and misdirects triage.
//
// As in `tests/cli-utils-exit-flush.test.js`, these spawn a real child
// process: `process.stdout` is synchronous on a TTY and on a file and only
// goes asynchronous once the 64 KiB kernel pipe buffer fills, so the
// truncation cannot be reproduced by stubbing `process.exit` in-process.
//
// Invariants pinned here:
//   - A >64 KiB report read by a slow pipe reader arrives complete and parses
//     as JSON (the defect: valid-prefix-then-nothing, still exit 0).
//   - Piping does not change the exit code — a piped run and a
//     redirected-to-file run agree on both bytes and status.
//   - The EXIT_CONFIG (3) catch arm still exits 3 now that it returns rather
//     than calling `process.exit()`.
//   - Structurally: `check-baselines.js` holds no `process.exit()` callsite.

import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test, { after, before, describe } from 'node:test';
import { fileURLToPath } from 'node:url';

import { currentKernelVersion } from '../.agents/scripts/lib/baselines/kernel.js';
import { makeTempDir } from '../.agents/scripts/lib/test-temp.js';
import { seedGitIdentity } from './fixtures/git-fixture.js';

const CLI = fileURLToPath(
  new URL('../.agents/scripts/check-baselines.js', import.meta.url),
);

/** One kernel pipe buffer on Linux and macOS — the truncation boundary. */
const PIPE_BUFFER = 64 * 1024;

/**
 * Rows in the fixture baseline. The compare arm emits one entry per row, so
 * this is what pushes the report clear of `PIPE_BUFFER`. The test asserts
 * that precondition rather than trusting it, so a future report-shape change
 * cannot quietly make this file pass vacuously.
 */
const ROW_COUNT = 900;

const BASELINE_REL = 'baselines/maintainability.json';

// Env with every `GIT_*` variable dropped. Under a husky pre-push from a
// linked worktree, git exports GIT_DIR pointing at the shared main gitdir —
// a fixture `git init` under that env writes `core.bare=true` into the MAIN
// checkout's `.git/config` (#4580).
const CLEAN_ENV = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')),
);

// `realpathSync`: on macOS `os.tmpdir()` is a symlink, and config resolution
// compares resolved paths — the fixture root must be the resolved one.
const TMP = fs.realpathSync(makeTempDir('check-baselines-pipe-flush-'));

/** @type {string} */
let root;

after(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

/**
 * A throwaway repo whose single enabled gate is a maintainability baseline of
 * `ROW_COUNT` long-pathed rows, committed at `origin/main` and identical in
 * the working tree. Floor-clean and regression-free by construction, so the
 * only thing under test is that a large report survives the pipe: every row
 * lands in the compare arm's `unchanged` list, which is what makes the
 * rendered JSON exceed one pipe buffer.
 *
 * @returns {string} Absolute path to the fixture root.
 */
function setupBulkRepo() {
  const dir = path.join(TMP, 'bulk-repo');
  fs.mkdirSync(path.join(dir, 'baselines'), { recursive: true });
  const git = (...args) =>
    execFileSync('git', args, {
      cwd: dir,
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf-8',
      env: CLEAN_ENV,
    });

  const rows = Array.from({ length: ROW_COUNT }, (_, i) => ({
    path: `src/module-${String(i).padStart(4, '0')}/deeply/nested/segment/file-name.js`,
    mi: 80 + (i % 10),
  }));
  fs.writeFileSync(
    path.join(dir, BASELINE_REL),
    JSON.stringify(
      {
        $schema: '.agents/schemas/baselines/maintainability.schema.json',
        kernelVersion: currentKernelVersion('maintainability'),
        generatedAt: '2026-01-01T00:00:00.000Z',
        rollup: { '*': { min: 80, p50: 90, p95: 100 } },
        rows,
      },
      null,
      2,
    ),
  );
  fs.writeFileSync(
    path.join(dir, '.agentrc.json'),
    JSON.stringify(
      {
        project: {
          baseBranch: 'main',
          paths: { agentRoot: '.agents', docsRoot: 'docs', tempRoot: 'temp' },
          docsContextFiles: [],
          commands: { test: 'echo', typecheck: 'echo' },
        },
        github: { owner: 'x', repo: 'y', operatorHandle: '@ci' },
        delivery: {
          quality: {
            gates: {
              maintainability: {
                enabled: true,
                baselinePath: BASELINE_REL,
                tolerance: { kind: 'absolute', value: 0.5 },
                floors: { '*': { min: 70 } },
              },
            },
          },
        },
      },
      null,
      2,
    ),
  );

  git('init', '-q', '-b', 'main');
  seedGitIdentity(dir);
  git('add', BASELINE_REL, '.agentrc.json');
  git('commit', '-q', '-m', 'seed baseline');
  // The compare arm reads `origin/<baseBranch>`; point the remote-tracking
  // ref at the local commit so `git show` resolves it without a remote.
  git('update-ref', 'refs/remotes/origin/main', 'main');

  return dir;
}

before(() => {
  root = setupBulkRepo();
});

/**
 * Spawn the CLI with stdout on a pipe and collect everything that reaches
 * the reader.
 *
 * @param {string[]} argv Arguments after the script path.
 * @param {{ slow?: boolean }} [opts] `slow` holds stdout paused so the child
 *   fills the pipe buffer and reaches its exit path with bytes still queued —
 *   the window the eager `process.exit()` discarded — then drains it in
 *   delayed slices. Only meaningful for a payload larger than `PIPE_BUFFER`:
 *   a child whose whole output fits in the buffer exits while the stream is
 *   still paused, and Node tears the pipe down with the buffered bytes
 *   unread, which would fail for a reason unrelated to the defect.
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
 */
async function runPiped(argv, { slow = false } = {}) {
  const child = spawn(process.execPath, [CLI, ...argv], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });

  const exited = new Promise((resolve) => {
    child.on('close', (code) => resolve(code));
  });

  if (slow) {
    child.stdout.pause();
    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  let stdout = '';
  for await (const chunk of child.stdout) {
    stdout += chunk.toString('utf8');
    if (slow) await new Promise((resolve) => setTimeout(resolve, 5));
  }

  return { code: await exited, stdout, stderr };
}

describe('check-baselines: stdout on a pipe', () => {
  test('a >64 KiB report survives a slow pipe reader intact', async () => {
    const { code, stdout, stderr } = await runPiped(['--no-friction'], {
      slow: true,
    });

    assert.ok(
      Buffer.byteLength(stdout, 'utf8') > PIPE_BUFFER,
      `fixture too small to exercise the defect: ${Buffer.byteLength(stdout, 'utf8')} bytes ` +
        `does not exceed one ${PIPE_BUFFER}-byte pipe buffer (stderr: ${stderr})`,
    );

    // The pre-fix binary delivered a valid *prefix* — one pipe buffer's worth
    // of well-formed JSON text that stops mid-object — so the assertion has
    // to be that the document parses, not that output was non-empty.
    let report;
    assert.doesNotThrow(
      () => {
        report = JSON.parse(stdout);
      },
      `report truncated at the pipe boundary (${Buffer.byteLength(stdout, 'utf8')} bytes)`,
    );
    assert.equal(report.schemaVersion, '1');
    assert.ok(
      Array.isArray(report.gates),
      'the report carries its gates array',
    );
    assert.equal(code, 0, `expected a green gate; stderr: ${stderr}`);
  });

  test('piping changes neither the byte count nor the exit code', async () => {
    const piped = await runPiped(['--no-friction'], { slow: true });

    // stdout on a file is synchronous, so this leg is the uncorrupted
    // reference the piped leg has to match exactly.
    const redirect = path.join(TMP, 'redirect.json');
    const fd = fs.openSync(redirect, 'w');
    const direct = spawnSync(process.execPath, [CLI, '--no-friction'], {
      cwd: root,
      stdio: ['ignore', fd, 'pipe'],
      encoding: 'utf8',
    });
    fs.closeSync(fd);
    const onFile = fs.readFileSync(redirect, 'utf8');

    assert.equal(
      Buffer.byteLength(piped.stdout, 'utf8'),
      Buffer.byteLength(onFile, 'utf8'),
      'a pipe must deliver the same bytes a file redirect does',
    );
    assert.equal(piped.stdout, onFile);
    assert.equal(
      piped.code,
      direct.status,
      'the exit code must not depend on what stdout is attached to',
    );
  });

  test('the EXIT_CONFIG arm still exits 3 through a pipe', async () => {
    // `--format` pre-validation throws before any gate runs, which is the
    // catch arm that used to call `process.exit(EXIT_CONFIG)` directly.
    const { code, stdout } = await runPiped([
      '--no-friction',
      '--format',
      'bogus',
    ]);

    assert.equal(code, 3, `expected EXIT_CONFIG; stdout: ${stdout}`);
    const report = JSON.parse(stdout);
    assert.equal(report.schemaVersion, '1');
    assert.match(report.error, /--format expects "json" or "text"/);
  });

  // The defect is a property of the source — `main()` bypassing the shared
  // non-eager settle path — so pin the source, not only the behaviour.
  // Mirrors the structural guard `cli-utils.js` carries for the same bug.
  //
  // `check-baseline-drift.js` is included because it is the same `main()`
  // verbatim (write `result.output`, `process.exit(result.exitCode)`, plus a
  // catch arm) over an equally unbounded payload — it prints one row per
  // drifted baseline entry full-scope.
  //
  // Story #5012 adds the two honesty-surface CLIs on the same grounds: both
  // print one line per divergent or pruned row across every baseline kind, so
  // a full-repo report on a neglected tree is unbounded in exactly the same
  // way. They adopt `runAsCli`'s settle path from birth; pinning them here is
  // what stops a later edit from "simplifying" it back to `process.exit()`.
  for (const rel of [
    '.agents/scripts/check-baselines.js',
    'scripts/check-baseline-drift.js',
    'scripts/check-baseline-scope.js',
    'scripts/prune-baseline-orphans.js',
  ]) {
    test(`${rel} contains no process.exit call`, () => {
      const source = fs.readFileSync(
        fileURLToPath(new URL(`../${rel}`, import.meta.url)),
        'utf8',
      );
      const code = source
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
      assert.equal(
        /process\.exit\s*\(/.test(code),
        false,
        `${rel} must return its exit code for runAsCli to settle, ` +
          'never call process.exit()',
      );
    });
  }
});
