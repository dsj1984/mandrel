/**
 * diagnose-friction.test.js — v5 / Epic #1030 Story #1042 Tests
 *
 * Tests the diagnose-friction.js script, which wraps commands and on
 * failure appends a structured `friction` signal to the per-Story
 * `temp/run-<eid>/stories/story-<sid>/signals.ndjson` stream via
 * `signals-writer.appendSignal`.
 *
 * Story #1042 cut the GitHub-comment side: there is no longer a
 * `postStructuredComment` call on the failure path. These tests verify:
 *   - The CLI contract (usage, exit-code passthrough, diagnostic banner).
 *   - On failure with `--story` + `--epic`, a `friction` signal is
 *     appended to the NDJSON stream with the expected `kind`/`category`/
 *     `source`/`details` payload shape.
 *   - The script never creates a local friction log file (v5 SSOT).
 *   - When story/epic context is unresolved, the script logs and skips the
 *     write (best-effort observability — never halt the runner).
 *
 * ## Why these spawns stay (Story #5111)
 *
 * Story #5111 converted the CLI suites that were paying a `node` cold start
 * to observe something their exported entry point already returns. This one is
 * not that. `diagnose-friction.js` is an *interceptor*: its subject is a child
 * process, and what these cases assert is what only a real process can produce
 * — an exit code passed through unchanged, the SIGTERM a `spawnSync` timeout
 * sends, an ENOENT from a binary that is not there, a >10 MiB stdout that must
 * complete, a >64 MiB stdout that overruns the wrapper ceiling, and stdout
 * drained through a pipe.
 *
 * Converting these would mean deleting the assertions the file exists for,
 * which is exactly what the Story's non-goals forbid. They are the sanctioned
 * exception, not an oversight.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { constants as osConstants } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { makeTempDir } from '../.agents/scripts/lib/test-temp.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SCRIPT_PATH = path.join(
  ROOT,
  '.agents',
  'scripts',
  'diagnose-friction.js',
);

let tmpRoot;

beforeEach(() => {
  tmpRoot = makeTempDir('diagnose-friction-');
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function runScript(extraArgs, extraEnv = {}, spawnOverrides = {}) {
  return spawnSync('node', [SCRIPT_PATH, ...extraArgs], {
    cwd: tmpRoot,
    encoding: 'utf-8',
    timeout: 60000,
    ...spawnOverrides,
    env: {
      ...process.env,
      GITHUB_TOKEN: 'fake-token-for-test',
      NO_NETWORK: '1',
      // Story #4696: pin the writer's scratch tempRoot at this test's own
      // tmpRoot so the spawned CLI lands its signal at
      // `<tmpRoot>/temp/run-<eid>/…` (where the assertions read), instead of
      // the shared per-process scratch dir the test bootstrap otherwise
      // injects into the inherited env.
      MANDREL_TEST_TEMP_ROOT: tmpRoot,
      ...extraEnv,
    },
  });
}

/**
 * Read the single friction record the CLI appended for the story/epic pair the
 * tests below use, asserting the stream holds exactly one line.
 */
function readSignal(epicId = 1030, storyId = 1042) {
  const ndjsonPath = path.join(
    tmpRoot,
    'temp',
    `run-${epicId}`,
    'stories',
    `story-${storyId}`,
    'signals.ndjson',
  );
  const lines = readFileSync(ndjsonPath, 'utf-8').trim().split('\n');
  assert.equal(lines.length, 1, 'exactly one friction signal is appended');
  return JSON.parse(lines[0]);
}

describe('diagnose-friction.js — v5 (CLI contract)', () => {
  it('exits non-zero when --cmd is missing', () => {
    const result = runScript([]);
    assert.notEqual(result.status, 0, 'Should fail when --cmd is missing');
    const combined = (result.stdout ?? '') + (result.stderr ?? '');
    assert.ok(
      combined.includes('Usage:'),
      'Should print usage instructions when --cmd is missing',
    );
  });

  it('passes through the exit code of the wrapped command on success', () => {
    const result = runScript(['--cmd', 'node', '--version']);
    assert.equal(
      result.status,
      0,
      'Should exit 0 when the wrapped command succeeds',
    );
  });

  it('passes through non-zero exit code of a failing wrapped command', () => {
    const result = runScript([
      '--cmd',
      'node',
      '__nonexistent_script_guaranteed_to_fail__.js',
    ]);
    assert.notEqual(
      result.status,
      0,
      'Should not exit 0 when the wrapped command fails',
    );
  });

  it('prints diagnostic suggestions on failure', () => {
    const result = runScript([
      '--cmd',
      'node',
      '__nonexistent_script_guaranteed_to_fail__.js',
    ]);
    const combined = (result.stdout ?? '') + (result.stderr ?? '');
    assert.ok(
      combined.includes('DIAGNOSTIC ANALYSIS'),
      'Should print the diagnostic analysis banner on failure',
    );
    assert.ok(
      combined.includes('Auto-Remediation Suggestions'),
      'Should print auto-remediation suggestions on failure',
    );
  });
});

describe('diagnose-friction.js — piped output past 64 KiB (Story #5686)', () => {
  const BYTES = 100_000;
  const emitter = (exitCode) =>
    `process.stdout.write('x'.repeat(${BYTES})); process.exitCode = ${exitCode};`;

  for (const exitCode of [0, 3]) {
    it(`forwards all ${BYTES} bytes through a pipe and exits ${exitCode}`, () => {
      const result = runScript(
        ['--cmd', 'node', '-e', emitter(exitCode)],
        {},
        {
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      assert.equal(result.stdout.length, BYTES, 'no stdout truncation');
      assert.equal(result.status, exitCode, 'exit status propagates');
    });
  }
});

describe('diagnose-friction.js — quoted-command usage error (Story #4915)', () => {
  /** Where a signal for the story/epic pair used below would land. */
  function ledgerPath(epicId = 1030, storyId = 1042) {
    return path.join(
      tmpRoot,
      'temp',
      `run-${epicId}`,
      'stories',
      `story-${storyId}`,
      'signals.ndjson',
    );
  }

  it('refuses a whole command passed as one quoted argument, naming the mistake', () => {
    // AC-2: `cmdArgs.length === 1` with whitespace inside can only be a caller
    // that quoted the command; the interceptor spawns argv words with no shell,
    // so the string could never be an executable name.
    const result = runScript([
      '--story',
      '1042',
      '--epic',
      '1030',
      '--cmd',
      'npm run lint',
    ]);

    assert.notEqual(result.status, 0, 'a usage error must exit non-zero');
    const combined = (result.stdout ?? '') + (result.stderr ?? '');
    assert.match(
      combined,
      /Usage:/,
      'the failure is reported as a usage error, not a wrapped-command failure',
    );
    assert.match(
      combined,
      /quoted/i,
      'the message names the quoting mistake rather than the ENOENT symptom',
    );
    assert.match(
      combined,
      /--cmd npm run lint/,
      'the message shows the corrected argv-split invocation',
    );
  });

  it('appends no ledger row for the quoting mistake', () => {
    // AC-2: recording it would discard the friction the caller meant to log and
    // eventually auto-file a framework-gap ticket about the interceptor itself.
    runScript(['--story', '1042', '--epic', '1030', '--cmd', 'npm run lint']);
    assert.equal(
      existsSync(ledgerPath()),
      false,
      'a usage error in the interceptor own invocation is not friction',
    );
  });

  it('still records a genuinely missing executable as spawn-failure friction', () => {
    // AC-3: the missing binary and the quoted misuse are indistinguishable from
    // the spawnSync result (both `status: null` + ENOENT). This pins that the
    // discrimination happens on `cmdArgs`, so real missing-tool friction lives.
    const result = runScript([
      '--story',
      '1042',
      '--epic',
      '1030',
      '--cmd',
      '__mandrel_no_such_executable__',
      '--version',
    ]);

    assert.notEqual(result.status, 0, 'a missing executable still fails');
    const signal = readSignal();
    assert.equal(signal.category, 'Execution Error');
    assert.equal(
      signal.details.killOrigin,
      'spawn-failure',
      'the missing-tool friction signal is preserved unchanged',
    );
    assert.equal(signal.details.killedBySignal, null);
  });
});

describe('diagnose-friction.js — appends friction signal to NDJSON', () => {
  it('appends a kind:friction record to signals.ndjson when story+epic are provided', () => {
    const result = runScript([
      '--story',
      '1042',
      '--epic',
      '1030',
      '--cmd',
      'node',
      '__nonexistent_script_guaranteed_to_fail__.js',
    ]);

    assert.notEqual(result.status, 0, 'wrapped command should fail');

    const ndjsonPath = path.join(
      tmpRoot,
      'temp',
      'run-1030',
      'stories',
      'story-1042',
      'signals.ndjson',
    );
    const raw = readFileSync(ndjsonPath, 'utf-8');
    const lines = raw.trim().split('\n');
    assert.equal(lines.length, 1, 'one friction signal should be appended');

    const signal = JSON.parse(lines[0]);
    assert.equal(signal.kind, 'friction', 'signal.kind must be "friction"');
    assert.equal(signal.epicId, 1030, 'signal.epicId carries the epic id');
    assert.equal(signal.storyId, 1042, 'signal.storyId carries the story id');
    assert.equal(
      signal.taskId,
      null,
      'signal.taskId is always null (2-tier: no Task tier)',
    );
    assert.ok(
      typeof signal.category === 'string' && signal.category.length > 0,
      'signal.category is set by the classifier',
    );
    assert.ok(
      signal.emitter && signal.emitter.tool === 'diagnose-friction.js',
      'signal.emitter.tool identifies the detector',
    );
    assert.ok(
      typeof signal.emitter.command === 'string' &&
        signal.emitter.command.length > 0,
      'signal.emitter.command captures the wrapped command',
    );
    assert.ok(
      signal.details &&
        typeof signal.details === 'object' &&
        typeof signal.details.errorPreview === 'string' &&
        signal.details.errorPreview.length > 0,
      'signal.details.errorPreview captures the error preview',
    );
    assert.ok(
      typeof signal.eventId === 'string' && signal.eventId.length > 0,
      'signal.eventId is a UUID',
    );
    assert.ok(typeof signal.ts === 'string', 'signal.ts is an ISO string');
  });

  it('classifies "Cannot find module" as Missing Skill', () => {
    runScript([
      '--story',
      '1042',
      '--epic',
      '1030',
      '--cmd',
      'node',
      '__nonexistent_script_guaranteed_to_fail__.js',
    ]);
    const ndjsonPath = path.join(
      tmpRoot,
      'temp',
      'run-1030',
      'stories',
      'story-1042',
      'signals.ndjson',
    );
    const signal = JSON.parse(readFileSync(ndjsonPath, 'utf-8').trim());
    assert.equal(
      signal.category,
      'Missing Skill',
      'Cannot find module → Missing Skill category',
    );
  });

  it('skips the signal write when story/epic context is unresolved', () => {
    const result = runScript([
      '--cmd',
      'node',
      '__nonexistent_script_guaranteed_to_fail__.js',
    ]);
    assert.notEqual(result.status, 0, 'wrapped command should fail');

    const stderr = result.stderr ?? '';
    assert.ok(
      stderr.includes('Skipping friction signal write') ||
        stderr.includes('story/epic context unresolved'),
      'Should log a skip message when context is unresolved',
    );
    // No NDJSON file should be created at all
    assert.throws(
      () =>
        readFileSync(
          path.join(
            tmpRoot,
            'temp',
            'run-1030',
            'story-1042',
            'signals.ndjson',
          ),
          'utf-8',
        ),
      /ENOENT/,
      'No signals.ndjson should be written without context',
    );
  });

  it('records an ordinary non-zero exit exactly as before signal handling (Story #4851 regression pin)', () => {
    // AC-6: a child that exits normally with a non-zero status must keep its
    // pre-#4851 category, preview, remediation text and exit code — the signal
    // branch may not leak into the ordinary failure path.
    const result = runScript([
      '--story',
      '1042',
      '--epic',
      '1030',
      '--cmd',
      'node',
      '-e',
      'process.exit(3)',
    ]);

    assert.equal(result.status, 3, 'exit code is passed through unchanged');

    const signal = readSignal();
    assert.equal(
      signal.category,
      'Execution Error',
      'no output + no marker → the generic default category, as before',
    );
    assert.equal(
      signal.details.errorPreview,
      'Unknown exit code 3',
      'the numeric-status fallback preview is unchanged',
    );
    assert.deepEqual(
      Object.keys(signal.details),
      ['errorPreview'],
      'details carries no termination keys for an ordinary exit',
    );
    assert.ok(
      (result.stderr ?? '').includes(
        'Generic failure. Review stderr above, refine your approach',
      ),
      'the default remediation text is unchanged',
    );
  });

  it('does not call postStructuredComment / write GitHub friction comments', () => {
    // Smoke check: with NO_NETWORK=1, the v5/Epic#1030 detector path must
    // not attempt any GitHub round-trip. The presence of the NDJSON write
    // (asserted in the first test) is the positive signal; here we just
    // confirm the script does not regress to printing the old
    // "Friction posted to Task #" line.
    const result = runScript([
      '--story',
      '1042',
      '--epic',
      '1030',
      '--cmd',
      'node',
      '__nonexistent_script_guaranteed_to_fail__.js',
    ]);
    const stderr = result.stderr ?? '';
    assert.ok(
      !stderr.includes('Friction posted to Task'),
      'must not print the legacy GitHub-comment success line',
    );
    assert.ok(
      !stderr.includes('postStructuredComment'),
      'must not reference postStructuredComment in failure paths',
    );
  });
});

/**
 * A child killed by a signal reports `status: null` with the cause in `signal`.
 * These cases drive that shape end-to-end through the real CLI, so they need a
 * platform where `process.kill` delivers a POSIX signal — on win32 there is no
 * signal to name and the OS reports an ordinary exit code instead.
 */
const POSIX_ONLY = { skip: process.platform === 'win32' };

/** The interceptor's own `executionTimeoutMs` bound under this repo's config. */
const EXECUTION_TIMEOUT_MS = 600000;

/** Run the CLI over a child that kills itself with `signalName`. */
function runSelfKill(signalName) {
  return runScript([
    '--story',
    '1042',
    '--epic',
    '1030',
    '--cmd',
    'node',
    '-e',
    `process.kill(process.pid, '${signalName}')`,
  ]);
}

describe(
  'diagnose-friction.js — signal-terminated child (Story #4851)',
  POSIX_ONLY,
  () => {
    it('records an externally-originated SIGKILL by name, not as Execution Error', () => {
      // AC-1 + AC-3: the signal is the whole diagnostic payload, and SIGKILL is
      // not the signal `spawnSync`'s own timeout would have sent.
      const result = runSelfKill('SIGKILL');
      assert.equal(
        result.signal,
        null,
        'the interceptor itself exits normally',
      );

      const signal = readSignal();
      assert.equal(
        signal.category,
        'Execution Killed',
        'category names the kill instead of the generic Execution Error bucket',
      );
      assert.equal(
        signal.details.killedBySignal,
        'SIGKILL',
        'details carries the signal name spawnSync reported',
      );
      assert.equal(
        signal.details.killOrigin,
        'external',
        'SIGKILL is not the interceptor timeout signal → externally originated',
      );
      assert.equal(
        signal.details.executionTimeoutMs,
        EXECUTION_TIMEOUT_MS,
        'details records the resolved bound in milliseconds',
      );
      assert.ok(
        (result.stderr ?? '').includes('originated outside the interceptor'),
        'the remediation tells the operator the bound did not fire',
      );
    });

    it('attributes a SIGTERM kill to the interceptor own timeout bound', () => {
      // AC-3: `spawnSync`'s `timeout` option kills with SIGTERM, so SIGTERM is
      // the interceptor cutting the command off rather than a host-level kill.
      runSelfKill('SIGTERM');
      const signal = readSignal();
      assert.equal(
        signal.category,
        'Execution Timeout',
        'a timeout-shaped kill gets its own category',
      );
      assert.equal(signal.details.killedBySignal, 'SIGTERM');
      assert.equal(
        signal.details.killOrigin,
        'interceptor-timeout',
        'the interceptor timeout signal is attributed to the interceptor',
      );
      assert.equal(signal.details.executionTimeoutMs, EXECUTION_TIMEOUT_MS);
    });

    it('never emits the "Unknown exit code null" preview', () => {
      // AC-2: both streams are empty on a hard kill, which is precisely how the
      // pre-#4851 fallback reached a literal that named nothing.
      const result = runSelfKill('SIGKILL');
      const combined = (result.stdout ?? '') + (result.stderr ?? '');
      assert.ok(
        !combined.includes('Unknown exit code null'),
        'no printed diagnostic contains "Unknown exit code null"',
      );

      const signal = readSignal();
      assert.ok(
        !JSON.stringify(signal).includes('Unknown exit code null'),
        'no emitted record contains "Unknown exit code null"',
      );
      assert.match(
        signal.details.errorPreview,
        /terminated by signal SIGKILL \(external\)/,
        'with both streams empty the preview names the signal',
      );
    });

    it('exits non-zero so the caller cannot read the run as successful', () => {
      // AC-4: the branch used to end in `process.exit(result.status)`, and
      // `process.exit(null)` exits 0 — the interceptor reported success for a
      // command it had just watched get killed.
      const result = runSelfKill('SIGKILL');
      assert.notEqual(
        result.status,
        0,
        'a signal-killed child must not surface as a successful run',
      );
      assert.equal(
        result.status,
        128 + osConstants.signals.SIGKILL,
        'exit code follows the shell 128 + signum convention',
      );
    });

    it('a >10 MiB command completes and is recorded with its real exit status (Story #5739)', () => {
      // The interceptor used to pass a 10 MiB `maxBuffer`, so a command this
      // chatty was killed and recorded as a buffer overflow. Routed through
      // the wrapper, it runs to its own exit and the row carries that status.
      const result = runScript(
        [
          '--story',
          '1042',
          '--epic',
          '1030',
          '--cmd',
          'node',
          '-e',
          "process.stdout.write('x'.repeat(11 * 1024 * 1024), () => process.exit(3))",
        ],
        {},
        { maxBuffer: 32 * 1024 * 1024 },
      );
      assert.equal(result.status, 3, 'the real exit status passes through');
      assert.equal(
        result.stdout.length,
        11 * 1024 * 1024,
        'the whole stdout is relayed, not a truncated prefix',
      );
      const signal = readSignal();
      assert.equal(signal.details.killedBySignal, undefined);
      assert.equal(signal.details.killOrigin, undefined);
      assert.equal(signal.details.executionMaxBuffer, undefined);
    });

    it('separates a maxBuffer overflow from a timeout, though both are SIGTERM (Story #4915)', () => {
      // AC-7 + AC-8: Node kills a `maxBuffer` overflow with SIGTERM too, so the
      // two shapes are distinguishable only by `error.code: 'ENOBUFS'`. Drive
      // both through the CLI seam and pin that they cannot silently re-merge.
      // The child's output must exceed the wrapper's 64 MiB ceiling (the
      // interceptor passes no `maxBuffer` of its own); this test's own capture
      // buffer must exceed that again, since the truncated output is relayed.
      const overflow = runScript(
        [
          '--story',
          '1042',
          '--epic',
          '1030',
          '--cmd',
          'node',
          '-e',
          "process.stdout.write('x'.repeat(65 * 1024 * 1024))",
        ],
        {},
        { maxBuffer: 128 * 1024 * 1024 },
      );
      assert.notEqual(overflow.status, 0, 'an overflowed child is a failure');
      const overflowSignal = readSignal();
      assert.equal(
        overflowSignal.details.killedBySignal,
        'SIGTERM',
        'the overflow presents as SIGTERM, exactly like a timeout',
      );
      assert.equal(
        overflowSignal.details.killOrigin,
        'buffer-overflow',
        'ENOBUFS gets its own killOrigin, distinct from interceptor-timeout',
      );
      assert.equal(
        overflowSignal.details.executionMaxBuffer,
        67108864,
        'the row records the bound that actually fired',
      );
      const overflowStderr = overflow.stderr ?? '';
      assert.match(
        overflowStderr,
        /executionMaxBuffer bound \(67108864 bytes \/ 64 MiB\)/,
        'remediation names the buffer bound, not the timeout bound',
      );
      assert.match(
        overflowStderr,
        /Do NOT split the command into smaller steps/,
        'the overflow must not inherit the timeout advice to split the command',
      );

      rmSync(path.join(tmpRoot, 'temp'), { recursive: true, force: true });

      const timeout = runSelfKill('SIGTERM');
      const timeoutSignal = readSignal();
      assert.equal(
        timeoutSignal.details.killedBySignal,
        'SIGTERM',
        'both shapes report the same signal — only error.code separates them',
      );
      assert.notEqual(
        timeoutSignal.details.killOrigin,
        overflowSignal.details.killOrigin,
        'SIGTERM with and without ENOBUFS must yield different killOrigin',
      );
      assert.equal(timeoutSignal.details.killOrigin, 'interceptor-timeout');
      assert.equal(
        timeoutSignal.details.executionMaxBuffer,
        undefined,
        'a real timeout carries no buffer bound — its details are unchanged',
      );
      assert.match(
        timeout.stderr ?? '',
        /Split it into smaller steps, or raise the bound/,
        'the timeout keeps the remediation it emits today',
      );
      assert.notEqual(
        timeout.stderr,
        overflowStderr,
        'the two shapes must not share remediation text',
      );
    });

    it('leaves source classification to the existing command scan', () => {
      // AC-5: naming the signal must not force `source: framework`. The scan in
      // source-classifier.js stays authoritative, so a consumer command killed
      // by its own host stays consumer-actionable.
      runSelfKill('SIGKILL');
      const signal = readSignal();
      assert.equal(
        signal.source,
        'consumer',
        'a consumer command killed by a signal stays classified consumer',
      );
    });
  },
);
