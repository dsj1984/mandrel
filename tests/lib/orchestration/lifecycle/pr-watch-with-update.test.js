// tests/lib/orchestration/lifecycle/pr-watch-with-update.test.js
/**
 * Unit tests for the `pr-watch-with-update.js` CLI (Story #3902).
 *
 * The CLI used to be an empty-bus emit shim that watched nothing and
 * always exited 0; Phase 8 therefore advanced to auto-merge with CI red
 * or still running. Story #3902 un-shimmed it onto the shared
 * `watchPrToTerminal` primitive. These tests pin the three load-bearing
 * paths through `runPrWatch` with injected `gh` spawns (no real network,
 * no real `process.exit`):
 *
 *   - green  → every required check terminal + green → exit 0
 *   - red    → a required check fails → exit 1, red check named in map
 *   - BEHIND → all green but PR is BEHIND base → one update-branch +
 *              re-poll → exit 0
 *
 * Plus the guard rails: a malformed `--pr` throws, and an unresolvable
 * `gh pr checks` failure exits non-zero while still printing the map.
 *
 * Story #4144 adds the CLI-wiring regression: the real `main()` path
 * injects NO gh ports, so `watchPrToTerminal` must default them to the
 * real `gh` invokers instead of throwing `ghPrChecksFn is not a
 * function`. That case drives `runPrWatch` with no function injection
 * against a fake `gh` on PATH.
 */

import assert from 'node:assert/strict';
import { chmodSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { makeTempDir } from '../../../../.agents/scripts/lib/test-temp.js';
import {
  REQUIRED_CONTEXT_ATTACH_WINDOW_MS,
  reconcileGreenVerdict,
  resolveWatchKnobs,
  runPrWatch,
  STILL_RUNNING_EXIT_CODE,
  WATCH_DEFAULTS,
} from '../../../../.agents/scripts/pr-watch-with-update.js';

function quietLogger() {
  return { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
}

function collectPrint() {
  const lines = [];
  return { print: (line) => lines.push(line), lines };
}

const greenChecks = {
  status: 0,
  stdout: JSON.stringify([
    { name: 'Validate and Test', state: 'SUCCESS', bucket: 'pass' },
    { name: 'baselines', state: 'SUCCESS', bucket: 'pass' },
  ]),
  stderr: '',
};

describe('runPrWatch — argument validation', () => {
  it('throws on a non-positive --pr', async () => {
    await assert.rejects(
      () => runPrWatch({ prNumber: 0, logger: quietLogger() }),
      /positive integer/,
    );
    await assert.rejects(
      () => runPrWatch({ prNumber: Number.NaN, logger: quietLogger() }),
      /positive integer/,
    );
  });
});

describe('runPrWatch — green path', () => {
  it('exits 0 and prints the outcomes map when every required check is green', async () => {
    const { print, lines } = collectPrint();
    const code = await runPrWatch({
      prNumber: 42,
      pollIntervalMs: 0,
      sleepFn: async () => {},
      ghPrChecksFn: () => greenChecks,
      // PR is CLEAN — no BEHIND recovery needed.
      ghPrViewFn: () => ({
        status: 0,
        stdout: JSON.stringify({ mergeStateStatus: 'CLEAN' }),
        stderr: '',
      }),
      logger: quietLogger(),
      print,
    });

    assert.equal(code, 0);
    assert.equal(lines.length, 1);
    const out = JSON.parse(lines[0]);
    assert.equal(out.green, true);
    assert.equal(out.terminal, true);
    assert.deepEqual(out.checkOutcomes, {
      'Validate and Test': 'success',
      baselines: 'success',
    });
  });
});

describe('runPrWatch — red path', () => {
  it('exits 1 and names the failing check in the printed map', async () => {
    const { print, lines } = collectPrint();
    const errorLines = [];
    const code = await runPrWatch({
      prNumber: 7,
      config: null,
      pollIntervalMs: 0,
      maxResumes: 0,
      sleepFn: async () => {},
      // No storyId → no digest is written (scoped by filename), so this
      // test never touches the filesystem. Story #4865: the red path also
      // disarms native auto-merge — stub that `gh` call so the unit test
      // never reaches a real PR.
      disarmAutoMergeFn: () => ({
        disarmed: true,
        alreadyUnarmed: false,
        detail: 'ok',
      }),
      ghPrChecksFn: () => ({
        status: 0,
        stdout: JSON.stringify([
          { name: 'Validate and Test', state: 'SUCCESS', bucket: 'pass' },
          { name: 'baselines', state: 'FAILURE', bucket: 'fail' },
        ]),
        stderr: '',
      }),
      logger: {
        ...quietLogger(),
        error: (m) => {
          errorLines.push(m);
        },
      },
      print,
    });

    assert.equal(code, 1);
    const out = JSON.parse(lines[0]);
    assert.equal(out.green, false);
    assert.equal(out.terminal, true);
    assert.equal(out.stillRunning, false);
    assert.equal(out.checkOutcomes.baselines, 'failure');
    // The failing check is named on one of the error lines (Story #4358
    // added the red-green remediation handoff line after it; #4482 retired
    // the loops/ starter units, so the handoff is prose, not a command).
    assert.ok(
      errorLines.some((l) => /baselines=failure/.test(l)),
      'failing check named in error output',
    );
    assert.ok(
      errorLines.some((l) => /apply the smallest fix/.test(l)),
      'red-green remediation handoff surfaced on red',
    );
  });
});

describe('runPrWatch — BEHIND recovery path', () => {
  it('issues one update-branch when all green but BEHIND, then exits 0', async () => {
    const { print, lines } = collectPrint();
    const calls = [];
    const viewResponses = [
      { status: 0, stdout: JSON.stringify({ mergeStateStatus: 'BEHIND' }) },
      { status: 0, stdout: JSON.stringify({ mergeStateStatus: 'CLEAN' }) },
    ];
    let viewIdx = 0;

    const code = await runPrWatch({
      prNumber: 99,
      pollIntervalMs: 0,
      sleepFn: async () => {},
      ghPrChecksFn: () => {
        calls.push('checks');
        return greenChecks;
      },
      ghPrViewFn: () => {
        calls.push('view');
        const r = viewResponses[Math.min(viewIdx, viewResponses.length - 1)];
        viewIdx += 1;
        return { ...r, stderr: '' };
      },
      ghPrUpdateBranchFn: () => {
        calls.push('update-branch');
        return { status: 0, stdout: '', stderr: '' };
      },
      logger: quietLogger(),
      print,
    });

    assert.equal(code, 0);
    const out = JSON.parse(lines[0]);
    assert.equal(out.green, true);
    assert.equal(out.updatesApplied, 1);
    // Canonical order: checks → view(BEHIND) → update-branch → ...
    const ubIdx = calls.indexOf('update-branch');
    assert.ok(ubIdx > 0, 'update-branch must be issued');
    assert.equal(calls[ubIdx - 1], 'view');
    assert.equal(
      calls.filter((c) => c === 'update-branch').length,
      1,
      'exactly one update-branch on a single BEHIND→CLEAN transition',
    );
  });
});

describe('runPrWatch — unresolvable gh failure', () => {
  it('exits 1 and still prints a map carrying the error', async () => {
    const { print, lines } = collectPrint();
    const code = await runPrWatch({
      prNumber: 13,
      pollIntervalMs: 0,
      sleepFn: async () => {},
      ghPrChecksFn: () => ({
        status: 1,
        stdout: '',
        stderr: 'gh: not authenticated',
      }),
      // Story #4890: an empty required set is classified against a STRUCTURAL
      // probe of the pull request itself. `gh` is unauthenticated here, so the
      // PR does not read back either — a genuine fault, still exit 1.
      ghPrViewFn: () => ({
        status: 1,
        stdout: '',
        stderr: 'gh: not authenticated',
      }),
      logger: quietLogger(),
      print,
    });

    assert.equal(code, 1);
    const out = JSON.parse(lines[0]);
    assert.equal(out.green, false);
    assert.ok(out.error, 'error field must be present');
    assert.equal(out.notYetStarted, false);
    assert.deepEqual(out.checkOutcomes, {});
  });

  it('does not spend the attach window when the pull request cannot be read', async () => {
    const { print, lines } = collectPrint();
    let checksCalls = 0;
    const code = await runPrWatch({
      prNumber: 13,
      pollIntervalMs: 0,
      sleepFn: async () => {},
      ghPrChecksFn: () => {
        checksCalls += 1;
        return { status: 1, stdout: '', stderr: 'gh: not authenticated' };
      },
      ghPrViewFn: () => ({ status: 1, stdout: '', stderr: 'boom' }),
      logger: quietLogger(),
      print,
    });

    assert.equal(code, 1);
    assert.equal(checksCalls, 1, 'a gh fault is not retried for 20 minutes');
    assert.equal(JSON.parse(lines[0]).attachRetries, undefined);
  });
});

// Regression for Story #4144. The CLI path (real `main()` → `runPrWatch`)
// injects NO gh ports, so `watchPrToTerminal` must default
// `ghPrChecksFn` / `ghPrViewFn` / `ghPrUpdateBranchFn` / `sleepFn` to the
// real invokers. Before the fix those params were `undefined` and
// `watchPrToTerminal` threw `TypeError: ghPrChecksFn is not a function`
// at the first probe (watcher.js:401). We exercise the un-stubbed wiring
// end to end by putting a fake `gh` on PATH (so the real spawns resolve
// to it) and driving `runPrWatch` with NO function injection — the
// precise call shape that used to crash.
describe('runPrWatch — CLI path wiring (no injected gh ports, Story #4144)', () => {
  let tmpDir;
  let originalPath;

  function pathDelimiter() {
    return process.platform === 'win32' ? ';' : ':';
  }

  /** Write an executable fake `gh` and prepend its dir to PATH. */
  function installFakeGh(script) {
    const ghPath = join(tmpDir, 'gh');
    writeFileSync(ghPath, script, { mode: 0o755 });
    chmodSync(ghPath, 0o755);
    process.env.PATH = `${tmpDir}${pathDelimiter()}${originalPath}`;
  }

  before(() => {
    tmpDir = makeTempDir('pr-watch-4144-');
    originalPath = process.env.PATH;
  });

  after(() => {
    process.env.PATH = originalPath;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('does not throw "ghPrChecksFn is not a function" and resolves via the real spawn', async (t) => {
    if (process.platform === 'win32') {
      // The fake-gh shim is a POSIX shell script. The wiring contract
      // (defaulted ports, no TypeError) is platform-independent and the
      // default-port resolution is exercised on Linux/macOS CI.
      t.skip('POSIX shell shim only');
      return;
    }

    // Fake `gh`: every required check green, merge state CLEAN (no BEHIND
    // recovery). `gh pr checks` is invoked with `--json`; `gh pr view`
    // with `mergeStateStatus`.
    installFakeGh(
      [
        '#!/usr/bin/env bash',
        'case "$*" in',
        '  *"pr checks"*)',
        '    echo \'[{"name":"Validate and Test","state":"SUCCESS","bucket":"pass"}]\'',
        '    ;;',
        '  *"pr view"*)',
        '    echo \'{"mergeStateStatus":"CLEAN"}\'',
        '    ;;',
        'esac',
        'exit 0',
        '',
      ].join('\n'),
    );

    const { print, lines } = collectPrint();
    // NB: NO ghPrChecksFn / ghPrViewFn / ghPrUpdateBranchFn injected —
    // this is the exact CLI call shape that used to throw a TypeError.
    let code;
    await assert.doesNotReject(async () => {
      code = await runPrWatch({
        prNumber: 4144,
        maxPolls: 2,
        pollIntervalMs: 0,
        sleepFn: async () => {},
        logger: quietLogger(),
        print,
      });
    }, 'CLI path must not throw "ghPrChecksFn is not a function"');

    assert.equal(code, 0, 'all-green CLI watch exits 0');
    const out = JSON.parse(lines[0]);
    assert.equal(out.green, true);
    assert.equal(out.terminal, true);
    assert.deepEqual(out.checkOutcomes, {
      'Validate and Test': 'success',
    });
  });
});

/**
 * Story #4873 — the watcher's two GitHub oracles are no longer trusted on a
 * single reading.
 *
 * Both defects were measured on this repo: a watch launched right after
 * `gh pr create` failed the delivery because the ruleset had not attached its
 * required contexts yet, and a watch reported GREEN while GitHub reported the
 * same PR BLOCKED because the observed required set was smaller than branch
 * protection's.
 */
/**
 * Story #4890 — the attach window has to survive the arrival latency of the
 * SLOWEST required context, and exhausting it is a slow condition, not a red
 * check.
 *
 * #4873 calibrated the window at 90 seconds against a cold ruleset. This
 * repository's required context is an aggregator job gated on every other
 * tier, so it is by construction the last check to appear — a measured case
 * attached 16m52s after the PR opened. The 90s window therefore still
 * exhausted, and exhaustion mapped onto exit 1 (the code the module reserves
 * for a check that genuinely failed) with no CI digest for the caller to read.
 */
describe('runPrWatch — required-context attach window (Stories #4873, #4890)', () => {
  // `gh` overloads exit 1 for "no required check is attached right now" and for
  // a genuine fault, and its stderr is human-readable prose, not a contract —
  // the classification must never be a match against this string.
  const emptyProbe = {
    status: 1,
    stdout: '',
    stderr: 'no required checks reported on the story-4890 branch',
  };
  const cleanView = () => ({
    status: 0,
    stdout: JSON.stringify({ mergeStateStatus: 'CLEAN' }),
    stderr: '',
  });

  it('converges on a required context that attaches ~17 minutes after the PR opens (AC-1)', async () => {
    const { print, lines } = collectPrint();
    // The measured aggregator attached at 16m52s. 102 empty probes at the 10s
    // default cadence advances the simulated clock to 17m00s — past the
    // measured case, and an order of magnitude past the retired 90s window
    // under which this exact watch aborted.
    const emptyProbes = 102;
    let calls = 0;
    let now = 0;
    const code = await runPrWatch({
      prNumber: 42,
      pollIntervalMs: 0,
      sleepFn: async () => {
        now += 10_000;
      },
      nowMsFn: () => now,
      ghPrChecksFn: () => {
        calls += 1;
        return calls <= emptyProbes ? emptyProbe : greenChecks;
      },
      ghPrViewFn: cleanView,
      logger: quietLogger(),
      print,
    });

    assert.equal(code, 0, 'a late-attaching required set is not a failure');
    const out = JSON.parse(lines[0]);
    assert.equal(out.green, true);
    assert.equal(out.attachRetries, emptyProbes);
    assert.equal(
      out.requiredChecksEmpty,
      undefined,
      'the converged watch reports the real required set, not the empty-set verdict',
    );
    assert.deepEqual(out.requiredChecks, ['Validate and Test', 'baselines']);
    assert.ok(
      now >= 17 * 60_000,
      `the context must attach past the measured 16m52s; clock reached ${now}ms`,
    );
  });

  it('reports the slow-but-not-red verdict and exits 2 once the window is spent (AC-2)', async () => {
    const { print, lines } = collectPrint();
    const warnings = [];
    let now = 0;
    const code = await runPrWatch({
      prNumber: 42,
      pollIntervalMs: 0,
      sleepFn: async () => {
        now += 30_000;
      },
      nowMsFn: () => now,
      ghPrChecksFn: () => emptyProbe,
      ghPrViewFn: cleanView,
      logger: { ...quietLogger(), warn: (m) => warnings.push(m) },
      print,
    });

    assert.equal(
      code,
      STILL_RUNNING_EXIT_CODE,
      'a still-empty required set is slow, never red',
    );
    const out = JSON.parse(lines[0]);
    assert.equal(out.requiredChecksEmpty, true);
    assert.equal(out.notYetStarted, true);
    assert.equal(out.green, false, 'and never a green verdict either');
    assert.ok(
      now >= REQUIRED_CONTEXT_ATTACH_WINDOW_MS,
      'the window is bounded — it does not poll forever',
    );
    assert.ok(warnings.some((m) => /has not started/.test(m)));
  });

  it('honours a caller-supplied window, so the wait is tunable per run', async () => {
    const { print, lines } = collectPrint();
    let calls = 0;
    let now = 0;
    const code = await runPrWatch({
      prNumber: 42,
      pollIntervalMs: 0,
      attachWindowMs: 0,
      sleepFn: async () => {
        now += 10_000;
      },
      nowMsFn: () => now,
      ghPrChecksFn: () => {
        calls += 1;
        return emptyProbe;
      },
      ghPrViewFn: cleanView,
      logger: quietLogger(),
      print,
    });

    assert.equal(code, STILL_RUNNING_EXIT_CODE);
    assert.equal(calls, 1, 'a zero window re-resolves nothing');
    assert.equal(JSON.parse(lines[0]).notYetStarted, true);
  });

  it('pins the window wide enough for a late aggregator (AC-1)', () => {
    assert.ok(
      REQUIRED_CONTEXT_ATTACH_WINDOW_MS >= 17 * 60_000,
      `the measured attach was 16m52s; window is ${REQUIRED_CONTEXT_ATTACH_WINDOW_MS}ms`,
    );
    assert.equal(
      WATCH_DEFAULTS.attachWindowMs,
      REQUIRED_CONTEXT_ATTACH_WINDOW_MS,
    );
  });
});

describe('resolveWatchKnobs — attachWindowMs ladder (Story #4890 AC-4, #5382)', () => {
  it('falls back to the framework default when no flag supplies one', () => {
    assert.equal(
      resolveWatchKnobs({}).attachWindowMs,
      WATCH_DEFAULTS.attachWindowMs,
    );
  });

  it('ignores a leftover delivery.ci.watch block — the config rung was removed', () => {
    const resolved = resolveWatchKnobs({
      config: { delivery: { ci: { watch: { attachWindowMs: 300_000 } } } },
    });
    assert.equal(resolved.attachWindowMs, WATCH_DEFAULTS.attachWindowMs);
  });

  it('lets a CLI flag override the default', () => {
    assert.equal(
      resolveWatchKnobs({ flags: { attachWindowMs: '45000' } }).attachWindowMs,
      45_000,
    );
  });
});

/**
 * Story #4890 AC-3 — `gh` has no `<owner/repo>#<number>` argument form; it
 * parses that string as a BRANCH NAME, so every `--repo` invocation failed at
 * the first probe with a misleading `gh-checks-failed:status=1`. The repository
 * must reach `gh` as a real flag.
 */
describe('runPrWatch — --repo is passed to gh as a real flag (Story #4890)', () => {
  it('never composes an <owner/repo>#<number> ref, and threads --repo to the checks port', async () => {
    const { print } = collectPrint();
    const seen = [];
    await runPrWatch({
      prNumber: 4890,
      repo: 'dsj1984/mandrel',
      pollIntervalMs: 0,
      sleepFn: async () => {},
      ghPrChecksFn: (args) => {
        seen.push(args);
        return greenChecks;
      },
      ghPrViewFn: () => ({
        status: 0,
        stdout: JSON.stringify({ mergeStateStatus: 'CLEAN' }),
        stderr: '',
      }),
      logger: quietLogger(),
      print,
    });

    assert.ok(seen.length > 0, 'the checks port was invoked');
    for (const args of seen) {
      assert.equal(args.repo, 'dsj1984/mandrel', 'repo travels as its own key');
      assert.equal(args.prUrl, '4890', 'the ref stays a bare PR number');
      assert.ok(
        !String(args.prUrl).includes('#'),
        `no gh argument may carry the composed form: ${args.prUrl}`,
      );
    }
  });

  it('omits --repo entirely when no repository is given, so gh infers it', async (t) => {
    if (process.platform === 'win32') {
      t.skip('POSIX shell shim only');
      return;
    }
    // The flag-building helper is module-private; assert it through the argv
    // the ports actually spawn. A blank repo must add no argument at all —
    // an empty `--repo ''` would make gh resolve nothing.
    const tmpDir = makeTempDir('pr-watch-4890-norepo-');
    const argvLog = join(tmpDir, 'argv.log');
    const originalPath = process.env.PATH;
    try {
      const ghPath = join(tmpDir, 'gh');
      writeFileSync(
        ghPath,
        [
          '#!/usr/bin/env bash',
          `printf '%s\\n' "$*" >> ${JSON.stringify(argvLog)}`,
          'case "$*" in',
          '  *"pr checks"*)',
          '    echo \'[{"name":"baselines","state":"SUCCESS","bucket":"pass"}]\'',
          '    ;;',
          '  *"pr view"*)',
          '    echo \'{"mergeStateStatus":"CLEAN"}\'',
          '    ;;',
          'esac',
          'exit 0',
          '',
        ].join('\n'),
        { mode: 0o755 },
      );
      chmodSync(ghPath, 0o755);
      process.env.PATH = `${tmpDir}${process.platform === 'win32' ? ';' : ':'}${originalPath}`;

      const { print, lines } = collectPrint();
      const code = await runPrWatch({
        prNumber: 4890,
        maxPolls: 2,
        pollIntervalMs: 0,
        sleepFn: async () => {},
        logger: quietLogger(),
        print,
      });

      assert.equal(code, 0, 'an inferred-repo invocation still resolves');
      assert.equal(JSON.parse(lines[0]).green, true);
      const argv = readFileSync(argvLog, 'utf8');
      assert.ok(
        !argv.includes('--repo'),
        `a nullish repo must contribute no flag, got:\n${argv}`,
      );
    } finally {
      process.env.PATH = originalPath;
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('resolves the pull request through the real spawn, with --repo in the argv', async (t) => {
    if (process.platform === 'win32') {
      t.skip('POSIX shell shim only');
      return;
    }
    const tmpDir = makeTempDir('pr-watch-4890-repo-');
    const argvLog = join(tmpDir, 'argv.log');
    const originalPath = process.env.PATH;
    try {
      const ghPath = join(tmpDir, 'gh');
      writeFileSync(
        ghPath,
        [
          '#!/usr/bin/env bash',
          `printf '%s\\n' "$*" >> ${JSON.stringify(argvLog)}`,
          'case "$*" in',
          '  *"pr checks"*)',
          '    echo \'[{"name":"baselines","state":"SUCCESS","bucket":"pass"}]\'',
          '    ;;',
          '  *"pr view"*)',
          '    echo \'{"mergeStateStatus":"CLEAN"}\'',
          '    ;;',
          'esac',
          'exit 0',
          '',
        ].join('\n'),
        { mode: 0o755 },
      );
      chmodSync(ghPath, 0o755);
      process.env.PATH = `${tmpDir}${process.platform === 'win32' ? ';' : ':'}${originalPath}`;

      const { print, lines } = collectPrint();
      const code = await runPrWatch({
        prNumber: 4890,
        repo: 'dsj1984/mandrel',
        maxPolls: 2,
        pollIntervalMs: 0,
        sleepFn: async () => {},
        logger: quietLogger(),
        print,
      });

      assert.equal(
        code,
        0,
        'a --repo invocation resolves the PR and goes green',
      );
      assert.equal(JSON.parse(lines[0]).green, true);
      const argv = readFileSync(argvLog, 'utf8');
      assert.match(
        argv,
        /pr checks 4890 .*--repo dsj1984\/mandrel/,
        `gh pr checks must carry --repo, got:\n${argv}`,
      );
      assert.ok(
        !argv.includes('dsj1984/mandrel#'),
        `no gh invocation may build the branch-name-shaped ref:\n${argv}`,
      );
    } finally {
      process.env.PATH = originalPath;
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('runPrWatch — green-verdict reconciliation (Story #4873 AC-4)', () => {
  it('withholds green and reports unresolved when GitHub still reports the PR BLOCKED', async () => {
    const { print, lines } = collectPrint();
    const warnings = [];
    const code = await runPrWatch({
      prNumber: 42,
      pollIntervalMs: 0,
      sleepFn: async () => {},
      ghPrChecksFn: () => greenChecks,
      ghPrViewFn: () => ({
        status: 0,
        stdout: JSON.stringify({ mergeStateStatus: 'BLOCKED' }),
        stderr: '',
      }),
      logger: { ...quietLogger(), warn: (m) => warnings.push(m) },
      print,
    });

    assert.equal(
      code,
      STILL_RUNNING_EXIT_CODE,
      'unresolved is keep-watching, never a green and never a red',
    );
    const out = JSON.parse(lines[0]);
    assert.equal(out.green, true, 'the observed set is reported honestly');
    assert.equal(out.reconciliation.reconciled, false);
    assert.equal(out.reconciliation.mergeStateStatus, 'BLOCKED');
    assert.ok(warnings.some((m) => /withholding the green verdict/.test(m)));
  });

  it('withholds green when the repository verdict cannot be read at all', async () => {
    const { print, lines } = collectPrint();
    const code = await runPrWatch({
      prNumber: 42,
      pollIntervalMs: 0,
      sleepFn: async () => {},
      ghPrChecksFn: () => greenChecks,
      ghPrViewFn: () => ({ status: 1, stdout: '', stderr: 'boom' }),
      logger: quietLogger(),
      print,
    });

    assert.equal(code, STILL_RUNNING_EXIT_CODE);
    const out = JSON.parse(lines[0]);
    assert.equal(out.reconciliation.reconciled, false);
    assert.equal(out.reconciliation.mergeStateStatus, null);
  });

  it('reconciles a green set the repository agrees with, and reports it on the envelope', async () => {
    const { print, lines } = collectPrint();
    const code = await runPrWatch({
      prNumber: 42,
      pollIntervalMs: 0,
      sleepFn: async () => {},
      ghPrChecksFn: () => greenChecks,
      ghPrViewFn: () => ({
        status: 0,
        stdout: JSON.stringify({ mergeStateStatus: 'CLEAN' }),
        stderr: '',
      }),
      logger: quietLogger(),
      print,
    });

    assert.equal(code, 0);
    const out = JSON.parse(lines[0]);
    assert.equal(out.reconciliation.reconciled, true);
    assert.equal(out.reconciliation.mergeStateStatus, 'CLEAN');
  });

  it('reconcileGreenVerdict: only a settled, non-blocking merge state reconciles', () => {
    for (const state of ['CLEAN', 'UNSTABLE', 'HAS_HOOKS', 'BEHIND']) {
      assert.equal(
        reconcileGreenVerdict({
          observedRequired: ['a'],
          mergeStateStatus: state,
        }).reconciled,
        true,
        state,
      );
    }
    for (const state of ['BLOCKED', 'UNKNOWN', 'DIRTY', '', null, undefined]) {
      assert.equal(
        reconcileGreenVerdict({
          observedRequired: ['a'],
          mergeStateStatus: state,
        }).reconciled,
        false,
        String(state),
      );
    }
  });
});
