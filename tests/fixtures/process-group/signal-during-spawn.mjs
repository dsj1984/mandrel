/**
 * The #5913 window, forced (Story #5913): spawn `suite-tree.mjs`, spin until
 * its worker is up — the preemption a loaded host can impose — then SIGTERM
 * this process before supervising it. `hold` goes through `spawnSupervised`,
 * as every spawn site now does; `bare` reproduces the old order, which leaks
 * the group.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  groupSpawnOptions,
  spawnSupervised,
  superviseGroup,
} from '../../../.agents/scripts/lib/process-group.js';

const [mode, pidFile] = process.argv.slice(2);
const tree = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'suite-tree.mjs',
);

/** Spawn, then hold the CPU until the worker is up and SIGTERM ourselves. */
function spawnThenSignal() {
  const child = spawn(process.execPath, [tree, pidFile], {
    stdio: 'ignore',
    ...groupSpawnOptions(),
  });
  const deadline = Date.now() + 20_000;
  while (!(fs.existsSync(pidFile) && fs.statSync(pidFile).size > 0)) {
    if (Date.now() > deadline) process.exit(2);
  }
  process.kill(process.pid, 'SIGTERM');
  return child;
}

const supervise = (child) =>
  superviseGroup(child, { signalOnParentSignal: 'SIGTERM' });
if (mode === 'hold') spawnSupervised(spawnThenSignal, supervise);
else supervise(spawnThenSignal());
setInterval(() => {}, 1000);
