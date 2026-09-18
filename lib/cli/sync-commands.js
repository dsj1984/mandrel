// lib/cli/sync-commands.js
/**
 * `mandrel sync-commands`: delegate to `.agents/scripts/sync-claude-commands.js`
 * in a child process (it has top-level await and no exported main), forwarding
 * output and exit code.
 *
 * Refuses first when `.agents/` does not match the running CLI — otherwise
 * commands are projected from a stale tree, and since `.claude/*` is
 * gitignored nothing surfaces until an agent hits a missing module. With the
 * `.agents/.mandrel-version` marker, compare it to the CLI's own version;
 * without it, fall back to the `agents-drift` content check.
 *
 * `PROJECT_ROOT` (the package root) answers only "what version is this CLI";
 * the marker is read from `cwd()`. Reading both from `PROJECT_ROOT` would
 * compare the package with itself and never fire.
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
const SYNC_SCRIPT = path.join(
  PROJECT_ROOT,
  '.agents',
  'scripts',
  'sync-claude-commands.js',
);

/**
 * @param {typeof nodeFs} fsImpl
 * @returns {string}
 */
function resolveOwnPackageVersion(fsImpl) {
  const parsed = JSON.parse(
    fsImpl.readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf8'),
  );
  return String(parsed.version);
}

/**
 * @param {string[]} _argv - Unused; reserved for future flags.
 * @param {{
 *   runner?: typeof spawnSync,
 *   cwd?: () => string,
 *   fs?: typeof nodeFs,
 *   ownVersion?: string,
 *   checkAgentsDrift?: () => { ok: boolean, detail: string },
 *   writeErr?: (s: string) => void,
 *   exit?: (code: number) => void,
 * }} [opts]
 * @returns {void}
 */
export default function run(
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
  const projectRoot = cwd();
  const resolvedOwnVersion = ownVersion ?? resolveOwnPackageVersion(fs);
  const marker = readVersionMarker(projectRoot, fs);

  if (marker) {
    if (marker !== resolvedOwnVersion) {
      writeErr(
        `mandrel sync-commands: the materialized .agents/ tree is v${marker} but the running CLI is v${resolvedOwnVersion} — refusing to project .claude/commands/ from a mismatched tree.\n` +
          '   → Run `mandrel sync` to re-materialize .agents/ to the current version, then re-run.\n',
      );
      exit(1);
      return;
    }
  } else {
    const drift = (checkAgentsDrift ?? (() => runAgentsDrift({ cwd })))();
    if (!drift.ok) {
      writeErr(
        `mandrel sync-commands: .agents/ appears to have drifted from the installed package payload (${drift.detail}) — refusing to project .claude/commands/ from a mismatched tree.\n` +
          '   → Run `mandrel sync` to restore the materialized .agents/ payload, then re-run.\n',
      );
      exit(1);
      return;
    }
  }

  const result = runner(process.execPath, [SYNC_SCRIPT], {
    stdio: 'inherit',
    env: process.env,
  });

  const exitCode = result.status ?? 1;
  if (exitCode !== 0) {
    exit(exitCode);
  }
}
