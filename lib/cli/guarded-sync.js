// lib/cli/guarded-sync.js
/**
 * Shared body of `mandrel sync-commands` / `mandrel sync-agents`: run a
 * `.agents/scripts/` projector in a child process, forwarding its exit code.
 * Refuses first when `.agents/` does not match the running CLI (version
 * marker, else the `agents-drift` check): `.claude/*` is gitignored, so a
 * stale projection surfaces only when an agent hits a missing module.
 * The marker is read from `cwd()`; `PROJECT_ROOT` only names this CLI's version.
 */

import { spawnSync } from 'node:child_process';
import nodeFs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runAgentsDrift } from './registry.js';
import { readVersionMarker } from './sync.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// lib/cli/ → lib/ → project root
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

function resolveOwnPackageVersion(fsImpl) {
  const parsed = JSON.parse(
    fsImpl.readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf8'),
  );
  return String(parsed.version);
}

function refusalReason(projectRoot, { fs, ownVersion, checkAgentsDrift, cwd }) {
  const marker = readVersionMarker(projectRoot, fs);
  if (marker) {
    const own = ownVersion ?? resolveOwnPackageVersion(fs);
    if (marker === own) return null;
    return {
      what: `the materialized .agents/ tree is v${marker} but the running CLI is v${own}`,
      fix: 're-materialize .agents/ to the current version',
    };
  }
  const drift = (checkAgentsDrift ?? (() => runAgentsDrift({ cwd })))();
  if (drift.ok) return null;
  return {
    what: `.agents/ appears to have drifted from the installed package payload (${drift.detail})`,
    fix: 'restore the materialized .agents/ payload',
  };
}

/** @param {{ command: string, target: string, script: string }} spec */
export function createGuardedSync({ command, target, script }) {
  const syncScript = path.join(PROJECT_ROOT, '.agents', 'scripts', script);
  return function run(
    _argv = [],
    {
      runner = spawnSync,
      cwd = () => process.cwd(),
      fs = nodeFs,
      ownVersion,
      checkAgentsDrift,
      writeErr = (s) => process.stderr.write(s),
      exit = (code) => process.exit(code),
    } = {},
  ) {
    const refusal = refusalReason(cwd(), {
      fs,
      ownVersion,
      checkAgentsDrift,
      cwd,
    });
    if (refusal) {
      writeErr(
        `mandrel ${command}: ${refusal.what} — refusing to project ${target} from a mismatched tree.\n` +
          `   → Run \`mandrel sync\` to ${refusal.fix}, then re-run.\n`,
      );
      exit(1);
      return;
    }
    const result = runner(process.execPath, [syncScript], {
      stdio: 'inherit',
      env: process.env,
    });
    const exitCode = result.status ?? 1;
    if (exitCode !== 0) exit(exitCode);
  };
}
