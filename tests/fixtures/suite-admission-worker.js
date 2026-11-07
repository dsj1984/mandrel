/**
 * One contending process for tests/lib/suite-admission-multiprocess.test.js.
 * argv[2] is a JSON spec: { name, lockPath, log, config, command, waitMs,
 * holdUntil?, holdMs?, viaHelper?, env?, backfillWindowMs?, goFile? }. `viaHelper`
 * admits through the consumer entry point under `env`. With `goFile` it appends
 * `ready` once booted and enters admission only when that file appears. The "suite" appends start/end lines (start
 * carries the marker it was handed) to `log` and
 * holds until the `holdUntil` file appears (or for `holdMs`). The first time
 * admission reports a capacity or resource wait, it appends one `blocked`
 * line — the positive signal a test waits on instead of a fixed sleep. Its
 * first wait appends one `waiting` line, stamped as it joins the queue.
 */
import fs from 'node:fs';

import {
  fullSuiteLockPolicy,
  SUITE_RESERVATION_ENV,
  withFullSuiteLockAsync,
  withSuiteAdmission,
} from '../../.agents/scripts/lib/full-suite-lock.js';

const spec = JSON.parse(process.argv[2]);

function note(event, extra = {}) {
  fs.appendFileSync(
    spec.log,
    `${JSON.stringify({ name: spec.name, event, at: Date.now(), ...extra })}\n`,
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const WAIT_REASONS = new Set(['capacity', 'resource']);
let reportedBlocked = false;

function onLockProgress(progress) {
  if (progress?.phase === 'waiting') note('waiting');
  if (reportedBlocked || !WAIT_REASONS.has(progress?.blocking?.reason)) return;
  reportedBlocked = true;
  note('blocked');
}

async function suite(lock) {
  note('start', { marker: lock?.env?.[SUITE_RESERVATION_ENV] ?? null });
  if (spec.holdUntil) {
    while (!fs.existsSync(spec.holdUntil)) await sleep(20);
  } else {
    await sleep(spec.holdMs ?? 0);
  }
  note('end');
  return 0;
}

const lockOptions = {
  lockPath: spec.lockPath,
  waitMs: spec.waitMs,
  pollMs: 25,
  reportMs: 50,
  backfillWindowMs: spec.backfillWindowMs,
  onLockProgress,
};

if (spec.goFile) {
  note('ready');
  while (!fs.existsSync(spec.goFile)) await sleep(10);
}

const code = spec.viaHelper
  ? await withSuiteAdmission(
      {
        argv: spec.command.split(' '),
        cwd: process.cwd(),
        env: spec.env ?? {},
        config: spec.config,
        lockOptions,
      },
      suite,
    )
  : await withFullSuiteLockAsync(
      {
        ...fullSuiteLockPolicy(spec.config, {}, spec.command.split(' ')),
        cwd: process.cwd(),
        env: {},
        ...lockOptions,
      },
      suite,
    );
note(`exit:${code}`);
process.exit(code);
