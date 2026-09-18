/**
 * Stands in for a full suite (Story #5377): forks a worker the way
 * `node --test` does, records the worker's pid, and idles. The worker is the
 * process a plain `kill(npm)` would leave behind — a test asserting it is
 * gone is asserting the whole process group was killed.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const [pidFile] = process.argv.slice(2);
const worker = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
  stdio: 'ignore',
});
fs.writeFileSync(pidFile, String(worker.pid));
setInterval(() => {}, 1000);
