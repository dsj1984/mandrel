/**
 * The detached half of the child-process surface; `child-exec.js` owns the
 * `node:child_process` import and injects `spawn` as `run`.
 */

import { closeSync, openSync } from 'node:fs';

/**
 * Start `file` detached and unreferenced, stdout and stderr appended to
 * `logPath`, so it outlives this process. Resolves with the pid once the
 * child has spawned; rejects on a spawn error (e.g. ENOENT).
 *
 * @param {string}   file
 * @param {string[]} args
 * @param {{ logPath: string, cwd?: string, run: Function, open?: Function, close?: Function }} opts
 * @returns {Promise<{ pid: number }>}
 */
export function detachChild(file, args, opts) {
  const { logPath, cwd, run, open = openSync, close = closeSync } = opts;
  const fd = open(logPath, 'a');
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      close(fd);
      fn(value);
    };
    let child;
    try {
      child = run(file, args, {
        cwd,
        detached: true,
        shell: false,
        stdio: ['ignore', fd, fd],
        windowsHide: true,
      });
    } catch (err) {
      settle(reject, err);
      return;
    }
    child.once('error', (err) => settle(reject, err));
    child.once('spawn', () => {
      child.unref();
      settle(resolve, { pid: child.pid });
    });
  });
}
