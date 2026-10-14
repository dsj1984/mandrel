/**
 * One contending process for tests/lib/suite-admission-multiprocess.test.js.
 * argv[2] is a JSON spec: { name, lockPath, log, config, command, waitMs,
 * holdUntil?, holdMs? }. The "suite" appends start/end lines to `log` and
 * holds until the `holdUntil` file appears (or for `holdMs`).
 */
import fs from 'node:fs';

import {
  fullSuiteLockPolicy,
  withFullSuiteLockAsync,
} from '../../.agents/scripts/lib/full-suite-lock.js';

const spec = JSON.parse(process.argv[2]);

function note(event) {
  fs.appendFileSync(
    spec.log,
    `${JSON.stringify({ name: spec.name, event, at: Date.now() })}\n`,
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function suite() {
  note('start');
  if (spec.holdUntil) {
    while (!fs.existsSync(spec.holdUntil)) await sleep(20);
  } else {
    await sleep(spec.holdMs ?? 0);
  }
  note('end');
  return 0;
}

const code = await withFullSuiteLockAsync(
  {
    ...fullSuiteLockPolicy(spec.config, {}, spec.command.split(' ')),
    cwd: process.cwd(),
    lockPath: spec.lockPath,
    waitMs: spec.waitMs,
    pollMs: 25,
    reportMs: 1_000,
  },
  suite,
);
note(`exit:${code}`);
process.exit(code);
