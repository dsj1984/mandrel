// tests/check-baselines-base-read-failure.test.js
//
// Story #4914 — check-baselines must not silently disable its compare arm
// when the base baseline cannot be read.
//
// The pre-fix behaviour: `readBaseBaselinePayload` wrapped the git read in a
// bare `catch { return null }`, so ANY hard read failure (the observed one
// being an ENOBUFS kill on a baseline larger than spawnSync's 1 MB default)
// collapsed to "no base baseline". The whole head-vs-base arm — regressions
// AND additions — then reported empty while the floors arm kept the run at
// exit 0. The gate looked green because it had stopped looking.
//
// Invariants pinned here:
//   - A hard base-read failure fails CLOSED as EXIT_CONFIG (3), never as a
//     clean exit 0 with an empty compare (AC-5, AC-6).
//   - An ABSENT base (git exit 128) keeps its old tolerant behaviour — that
//     distinction is what `readBaseFromGit` draws and what this fix relies on.
//   - The per-gate report carries `baseRead`, so the condition is diagnosable
//     from the JSON alone (AC-7).

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { runCheckBaselines } from '../.agents/scripts/check-baselines.js';
import { EXIT_CONFIG } from '../.agents/scripts/lib/baselines/exit-codes.js';
import {
  __resetForTests,
  __setSpawnRunner,
} from '../.agents/scripts/lib/baselines/git-base.js';
import { currentKernelVersion } from '../.agents/scripts/lib/baselines/kernel.js';
import { makeTempDir } from '../.agents/scripts/lib/test-temp.js';

const MI_BASELINE_REL = 'baselines/maintainability.json';

function miEnvelope(rows) {
  return {
    $schema: 'maintainability.schema.json',
    kernelVersion: currentKernelVersion('maintainability'),
    generatedAt: '2026-01-01T00:00:00.000Z',
    rollup: { '*': { min: 80, p50: 90, p95: 100 } },
    rows,
  };
}

/** Temp project root with one diff-scoped maintainability gate. */
function setupTmpRepo() {
  const root = makeTempDir('check-baselines-base-read-');
  mkdirSync(path.join(root, 'baselines'), { recursive: true });
  writeFileSync(
    path.join(root, '.agentrc.json'),
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
            gateScoping: { scope: 'diff', diffRef: 'main' },
            gates: {
              maintainability: {
                enabled: true,
                baselinePath: MI_BASELINE_REL,
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
  // Head baseline: floor-clean, so nothing but the compare arm can fail.
  writeFileSync(
    path.join(root, MI_BASELINE_REL),
    JSON.stringify(miEnvelope([{ path: 'src/a.js', mi: 80 }]), null, 2),
  );
  return root;
}

/**
 * Git stub whose `show` dies the way an oversize baseline dies under the 1 MB
 * spawnSync default: killed by signal, so `status` is null rather than a git
 * exit code. `log` stays healthy so the failure under test is unambiguous.
 */
function installEnobufsStub() {
  __setSpawnRunner({
    spawn: (_cmd, args) => {
      if (args?.[0] === 'show') {
        return {
          status: null,
          signal: 'SIGTERM',
          stdout: 'x'.repeat(1024),
          stderr: '',
          error: Object.assign(new Error('spawnSync git ENOBUFS'), {
            code: 'ENOBUFS',
          }),
        };
      }
      return { status: 0, stdout: '', stderr: '' };
    },
  });
}

function installHealthyStub(baseRows) {
  const baseJson = JSON.stringify(miEnvelope(baseRows));
  __setSpawnRunner({
    spawn: (_cmd, args) => {
      if (args?.[0] === 'show') {
        const spec = args?.[1] ?? '';
        if (spec.endsWith(`:${MI_BASELINE_REL}`)) {
          return { status: 0, stdout: baseJson, stderr: '' };
        }
        return { status: 128, stdout: '', stderr: 'no base' };
      }
      return { status: 0, stdout: '', stderr: '' };
    },
  });
}

describe('check-baselines — base-read failure fails closed (#4914)', () => {
  let root;

  beforeEach(() => {
    __resetForTests();
    root = setupTmpRepo();
  });

  afterEach(() => {
    __resetForTests();
    if (root) rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  // AC-5 — the read failure propagates as an EXIT_CONFIG-carrying error.
  // `check-baselines.js#main` maps any throw out of the pipeline onto that
  // code, so this is the run's exit status: 3, not 0.
  it('propagates a hard base-read failure as an EXIT_CONFIG (3) error', async () => {
    installEnobufsStub();
    let thrown = null;
    try {
      await runCheckBaselines({ argv: ['--no-friction'], cwd: root });
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown instanceof Error, 'the run must not resolve');
    assert.equal(thrown.exitCode, EXIT_CONFIG);
    assert.equal(thrown.exitCode, 3);
    assert.equal(thrown.code, 'EXIT_CONFIG');
    assert.match(thrown.message, /could not read the base baseline/);
  });

  // AC-5 — the same failure driven through the real CLI, so the assertion is
  // the process exit status rather than a mapping read off the source. A `git`
  // shim earlier on PATH fails the `show` the way a broken read fails it; the
  // shim is a POSIX shell script, so the leg is skipped on Windows.
  it('the check-baselines CLI exits 3 (not 0) when the base read fails', {
    skip: process.platform === 'win32' ? 'POSIX git shim' : false,
  }, () => {
    const binDir = path.join(root, 'shim-bin');
    mkdirSync(binDir, { recursive: true });
    const shim = path.join(binDir, 'git');
    // `show` fails hard (status 1 — not 128, so not "path absent"); every
    // other subcommand succeeds emptily so nothing else is disturbed.
    writeFileSync(
      shim,
      '#!/bin/sh\nif [ "$1" = "show" ]; then\n' +
        '  echo "fatal: simulated hard read failure" >&2\n  exit 1\nfi\nexit 0\n',
      { mode: 0o755 },
    );

    const cli = fileURLToPath(
      new URL('../.agents/scripts/check-baselines.js', import.meta.url),
    );
    const res = spawnSync(process.execPath, [cli, '--no-friction'], {
      cwd: root,
      encoding: 'utf-8',
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` },
    });

    assert.equal(
      res.status,
      3,
      `expected EXIT_CONFIG; got ${res.status}\nstdout: ${res.stdout}\nstderr: ${res.stderr}`,
    );
    assert.notEqual(res.status, 0, 'the pre-fix behaviour was a green exit 0');
    assert.match(res.stdout, /could not read the base baseline/);
  });

  // AC-6 — the pre-fix scenario stated as its own assertion: the exact shape
  // that used to come back (a clean report, empty compare, exit 0) must now
  // be unreachable for this input.
  it('never reports an empty compare at exit 0 when the base read failed', async () => {
    installEnobufsStub();
    let resolved = null;
    try {
      resolved = await runCheckBaselines({
        argv: ['--no-friction'],
        cwd: root,
      });
    } catch {
      resolved = null;
    }
    assert.equal(
      resolved,
      null,
      'a failed base read must not yield a report at all — the pre-fix bug ' +
        'returned regressions: [] / additions: [] at exit 0',
    );
  });

  // The other side of the distinction: an ABSENT base at the ref (git exit
  // 128) is not a failure and keeps its tolerant exit-0 behaviour.
  it('still exits 0 when the base baseline is merely absent at the ref', async () => {
    __setSpawnRunner({
      spawn: (_cmd, args) => {
        if (args?.[0] === 'show') {
          return { status: 128, stdout: '', stderr: 'fatal: path missing' };
        }
        return { status: 0, stdout: '', stderr: '' };
      },
    });
    const res = await runCheckBaselines({ argv: ['--no-friction'], cwd: root });
    assert.equal(res.exitCode, 0);
    const gate = res.report.gates.find((g) => g.kind === 'maintainability');
    assert.equal(gate.baseRead, false, 'absent base is reported, not hidden');
  });

  // Story #5277 AC-10 — the second way a base read fails.
  //
  // #4914 drew the line at the git call: a throw fails closed, exit 128 means
  // "absent". It left the PARSE on the tolerant side, so a base blob that git
  // handed over intact but that did not parse as JSON reported zero
  // regressions at exit 0 — a gate trusted precisely because it looks green.
  // Text-merged baselines are how such a blob reaches a base branch, which is
  // the failure the merge driver removes upstream; this is what stops it being
  // silent when it happens anyway.
  it('exits non-zero naming the base file when the base baseline will not parse', async () => {
    __setSpawnRunner({
      spawn: (_cmd, args) => {
        if (args?.[0] === 'show') {
          const spec = args?.[1] ?? '';
          if (spec.endsWith(`:${MI_BASELINE_REL}`)) {
            // The shape a text merge leaves behind.
            return {
              status: 0,
              stdout:
                '<<<<<<< HEAD\n{ "rows": [] }\n=======\n{ "rows": [] }\n>>>>>>> theirs\n',
              stderr: '',
            };
          }
          return { status: 128, stdout: '', stderr: 'no base' };
        }
        return { status: 0, stdout: '', stderr: '' };
      },
    });

    let thrown = null;
    try {
      await runCheckBaselines({ argv: ['--no-friction'], cwd: root });
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown instanceof Error, 'an unparseable base must not resolve');
    assert.equal(thrown.exitCode, EXIT_CONFIG);
    assert.match(thrown.message, /could not read the base baseline/);
    // Naming the file is the whole diagnostic: the operator has to know WHICH
    // baseline on the base branch is corrupt.
    assert.match(thrown.message, new RegExp(MI_BASELINE_REL));
    assert.equal(thrown.baselinePath, MI_BASELINE_REL);
    assert.equal(thrown.baseRef, 'main');
  });

  // AC-7 — a normal run that DID read its base says so on the gate report.
  it('reports baseRead: true on a gate whose base baseline was read', async () => {
    installHealthyStub([{ path: 'src/a.js', mi: 80 }]);
    const res = await runCheckBaselines({ argv: ['--no-friction'], cwd: root });
    assert.equal(res.exitCode, 0);
    const gate = res.report.gates.find((g) => g.kind === 'maintainability');
    assert.ok(gate, 'maintainability gate present');
    assert.equal(
      Object.hasOwn(gate, 'baseRead'),
      true,
      'baseRead must reach the per-gate report object',
    );
    assert.equal(gate.baseRead, true);
  });
});
