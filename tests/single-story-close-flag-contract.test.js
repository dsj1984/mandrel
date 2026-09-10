/**
 * tests/single-story-close-flag-contract.test.js
 *
 * Story #5100 — `--help` is the flag contract, so the descriptor must be TRUE.
 *
 * `tests/enforcement/workflow-script-help.test.js` (Story #4750) asserts that
 * every workflow-invoked script *answers* `--help`. It cannot assert that what
 * the script says is honoured, and that gap minted two phantom flags on this
 * CLI: `--dry-run` and `--no-evidence` were advertised, parsed into a field
 * nothing read, and silently ignored — so a "dry run" performed a real
 * base-sync merge and could leave the Story `agent::blocked`.
 *
 * Two halves close that gap here:
 *
 *   1. every advertised flag maps to an option `parseCloseOptions` actually
 *      returns, so re-adding a phantom flag fails; and
 *   2. the retired flags are rejected rather than ignored — `parseSprintArgs`
 *      runs `parseArgs` with `strict: false`, so deletion ALONE would leave
 *      `--dry-run` silently absorbed and the close running for real.
 *
 * **Everything drives `parseCloseOptions`, never the guard helper directly.**
 * The helper is module-private precisely so it cannot be tested in isolation:
 * an assertion against it would still pass with its call site deleted, which
 * is a vacuous guard — correct code that is never consulted, the same defect
 * class this Story fixes. Driving the real CLI as a subprocess would be more
 * faithful still, but a regression there performs a REAL close against the
 * Story, so the hazard is reproduced in-process where a failure costs nothing.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { parseCloseOptions } from '../.agents/scripts/lib/orchestration/single-story-close/phases/options.js';

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const CLI = path.join(REPO_ROOT, '.agents/scripts/single-story-close.js');

const RETIRED = ['--dry-run', '--no-evidence'];

/**
 * The advertised surface, read off the real `--help` output rather than the
 * source, because the rendered text is what an operator actually reads.
 * Descriptions wrap onto deeper-indented continuation lines, so anchoring on
 * exactly two leading spaces takes flags and never prose that mentions one.
 */
function advertisedFlags() {
  const help = execFileSync(process.execPath, [CLI, '--help'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return help
    .split('\n')
    .map((line) => /^ {2}(--[a-z][a-z0-9-]*)/.exec(line))
    .filter(Boolean)
    .map((m) => m[1]);
}

/** Run `fn` with `process.argv` stubbed to a close argv, always restoring it. */
function withArgv(tail, fn) {
  const saved = process.argv;
  process.argv = [process.execPath, CLI, ...tail];
  try {
    return fn();
  } finally {
    process.argv = saved;
  }
}

/**
 * Advertised flag → the `parseCloseOptions` key that carries it.
 *
 * Deliberately explicit rather than a camelCase derivation: three flags are
 * renamed on the way through (`--wait-merge` becomes `waitForMergeExplicit`
 * because the resolved value is not knowable at parse time), and a derivation
 * that tolerated those would also tolerate a flag mapped to nothing. Adding a
 * flag means adding a row here with a key that really exists.
 */
const FLAG_TO_OPTION = Object.freeze({
  '--story': 'storyId',
  '--cwd': 'cwd',
  '--skip-validation': 'skipValidation',
  '--skip-sync': 'skipSync',
  '--no-auto-merge': 'noAutoMerge',
  '--wait-merge': 'waitForMergeExplicit',
  '--no-wait-merge': 'noWaitForMerge',
  '--max-wait-seconds': 'maxWaitSeconds',
  '--merge-watch-mode': 'mergeWatchMode',
  '--rerun-advisory': 'rerunAdvisory',
  '--override-review-block': 'overrideReviewBlock',
});

/** Answered by `runAsCli` before `main`, so no pipeline option backs it. */
const FRAMEWORK_FLAGS = new Set(['--help']);

describe('single-story-close --help advertises only flags the pipeline honours', () => {
  it('maps every advertised flag to an option parseCloseOptions returns', () => {
    // An injected `storyId` makes this argv-independent, so the test runner's
    // own flags cannot leak into the parse.
    const options = parseCloseOptions({ storyIdParam: 5100 });
    const unbacked = advertisedFlags()
      .filter((flag) => !FRAMEWORK_FLAGS.has(flag))
      .filter((flag) => {
        const key = FLAG_TO_OPTION[flag];
        return key === undefined || !(key in options);
      });
    assert.deepEqual(
      unbacked,
      [],
      `--help advertises flag(s) no close option carries: ${unbacked.join(', ')}. ` +
        'Wire the flag through parseCloseOptions, or drop it from the usage descriptor.',
    );
  });

  for (const flag of RETIRED) {
    it(`no longer advertises ${flag}`, () => {
      assert.ok(
        !advertisedFlags().includes(flag),
        `${flag} was never implemented in this pipeline; it must not be advertised.`,
      );
    });
  }
});

describe('parseCloseOptions rejects retired flags on its argv door', () => {
  for (const flag of RETIRED) {
    it(`throws when argv carries a bare ${flag}`, () => {
      assert.throws(
        () => withArgv(['--story', '5100', flag], () => parseCloseOptions({})),
        (err) =>
          err.message.includes(flag) &&
          /nothing was mutated/i.test(err.message),
        `${flag} must fail closed, naming itself and stating nothing was mutated.`,
      );
    });

    it(`throws when argv carries ${flag}=value`, () => {
      assert.throws(
        () => withArgv([`${flag}=true`], () => parseCloseOptions({})),
        new RegExp(`${flag} was retired`),
      );
    });
  }

  it('still parses a clean argv through the same door', () => {
    const options = withArgv(['--story', '5100', '--skip-sync'], () =>
      parseCloseOptions({}),
    );
    assert.equal(options.storyId, 5100);
    assert.equal(options.skipSync, true);
  });

  it('does not trip on a positional that merely contains the text', () => {
    // Built from `path.sep`, and compared against `path.resolve` of the same
    // input, because `parseCloseOptions` normalises `cwd` through
    // `path.resolve`. A POSIX literal is a no-op there on POSIX but becomes
    // `C:\tmp\...` on Windows, which reds the advisory Windows Smoke job for a
    // platform artefact rather than a regression.
    const cwdArg = `${path.sep}tmp${path.sep}repo--dry-run${path.sep}checkout`;
    assert.ok(
      cwdArg.includes('--dry-run'),
      'the positional must still embed the retired flag, or this proves nothing.',
    );
    const options = withArgv(['--story', '5100', '--cwd', cwdArg], () =>
      parseCloseOptions({}),
    );
    assert.equal(options.cwd, path.resolve(cwdArg));
  });

  it('does not consult argv when the caller injects a storyId', () => {
    // An injecting caller's options must not be poisoned by the host process's
    // own flags — a test runner's argv is not close's input.
    const options = withArgv(['--dry-run'], () =>
      parseCloseOptions({ storyIdParam: 5100 }),
    );
    assert.equal(options.storyId, 5100);
  });
});

describe('the shared parser cannot be left to reject these on its own', () => {
  it('absorbs a retired flag instead of rejecting it', async () => {
    const { parseSprintArgs } = await import(
      '../.agents/scripts/lib/cli-args.js'
    );
    const parsed = parseSprintArgs([
      process.execPath,
      CLI,
      '--story',
      '5100',
      '--dry-run',
    ]);
    // The parse SUCCEEDS with a retired flag present: `strict: false` absorbs
    // it and hands back a valid options bag, so the close would run for real.
    // That is the hazard the guard exists to cover.
    assert.equal(parsed.storyId, 5100);
  });

  it('no longer surfaces noEvidence', async () => {
    const { parseSprintArgs } = await import(
      '../.agents/scripts/lib/cli-args.js'
    );
    const parsed = parseSprintArgs([process.execPath, CLI, '--story', '5100']);
    assert.ok(
      !('noEvidence' in parsed),
      'noEvidence had zero readers repo-wide; the working --no-evidence lives on the gate wrappers.',
    );
  });

  it('still surfaces dryRun, which single-story-init.js reads', async () => {
    const { parseSprintArgs } = await import(
      '../.agents/scripts/lib/cli-args.js'
    );
    const parsed = parseSprintArgs([
      process.execPath,
      CLI,
      '--story',
      '5100',
      '--dry-run',
    ]);
    assert.equal(parsed.dryRun, true);
  });
});
