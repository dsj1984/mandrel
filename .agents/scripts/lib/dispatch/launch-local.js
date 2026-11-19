/**
 * The `local` launch target: start a Story's delivery as a detached process
 * on this machine and stop it again. The argv is spawned as an array, never
 * through a shell.
 *
 * @module lib/dispatch/launch-local
 */

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { spawnDetached } from '../child-exec.js';
import { dispatchLogPath } from '../config/temp-paths.js';
import { commandFor, wantsSessionId } from './environments.js';

/** The argv with a fresh session id, plus that id when the command used it. */
function sessionLaunch(command, storyId, sessionId) {
  const argv = commandFor(command, storyId, sessionId);
  return wantsSessionId(command) ? { argv, sessionId } : { argv };
}

/**
 * @param {{ storyId: number, environment: import('./environments.js').Environment,
 *   cwd: string, config?: object }} args
 * @param {{ spawnImpl?: typeof spawnDetached, fsImpl?: typeof fs,
 *   now?: () => Date, uuid?: () => string }} [deps]
 * @returns {Promise<import('./record.js').DispatchRecord>}
 */
export async function launchLocal(
  { storyId, environment, cwd, config },
  {
    spawnImpl = spawnDetached,
    fsImpl = fs,
    now = () => new Date(),
    uuid = randomUUID,
  } = {},
) {
  const session = sessionLaunch(environment.command, storyId, uuid());
  const logPath = dispatchLogPath(storyId, config);
  fsImpl.mkdirSync(path.dirname(logPath), { recursive: true });
  const [file, ...args] = session.argv;
  const { pid } = await spawnImpl(file, args, { logPath, cwd });
  return {
    storyId,
    environment: environment.name,
    pid,
    startedAt: now().toISOString(),
    logPath,
    ...session,
  };
}

/**
 * Terminate a launched delivery: its process group where groups exist
 * (detached children lead their own), else the pid. A process that is
 * already gone counts as stopped.
 *
 * @param {number} pid
 * @param {{ kill?: typeof process.kill, platform?: string }} [deps]
 * @returns {boolean} Whether a live process was signalled.
 */
export function stopLocal(
  pid,
  { kill = process.kill.bind(process), platform = process.platform } = {},
) {
  const targets = platform === 'win32' ? [pid] : [-pid, pid];
  for (const target of targets) {
    try {
      kill(target, 'SIGTERM');
      return true;
    } catch (err) {
      if (err?.code !== 'ESRCH') throw err;
    }
  }
  return false;
}
