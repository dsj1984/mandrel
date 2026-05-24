/* node:coverage ignore file */
/**
 * Preload module for `test-isolate`. Snapshots `process.env` at module load
 * time and writes a diff envelope to the file named in
 * `TEST_ISOLATE_ENV_OUT` when the process exits. Used to surface env-var
 * mutations a test made and failed to restore.
 */

import fs from 'node:fs';

const OUT_PATH = process.env.TEST_ISOLATE_ENV_OUT;
if (OUT_PATH) {
  const beforeSnapshot = { ...process.env };
  // NODE_OPTIONS propagates this loader into every node process spawned
  // beneath the runner (including node:test's per-file child workers). We
  // write to a per-pid sidecar file so the parent runner can pick the
  // child's diff and ignore its own empty one.
  const pidPath = `${OUT_PATH}.${process.pid}.json`;
  process.on('exit', () => {
    try {
      const after = process.env;
      const added = [];
      const removed = [];
      const changed = [];
      const IGNORE = new Set([
        'TEST_ISOLATE_ENV_OUT',
        // NODE_OPTIONS is rewritten by the parent's spawn; ignore it so
        // the loader doesn't flag itself as a leak.
        'NODE_OPTIONS',
      ]);
      for (const key of Object.keys(after)) {
        if (IGNORE.has(key)) continue;
        if (!(key in beforeSnapshot)) added.push(key);
        else if (beforeSnapshot[key] !== after[key]) changed.push(key);
      }
      for (const key of Object.keys(beforeSnapshot)) {
        if (IGNORE.has(key)) continue;
        if (!(key in after)) removed.push(key);
      }
      if (added.length === 0 && removed.length === 0 && changed.length === 0) {
        return;
      }
      fs.writeFileSync(
        pidPath,
        JSON.stringify({ added, removed, changed }),
        'utf8',
      );
    } catch {
      // Best-effort — do not interfere with the host process exit.
    }
  });
}
