// lib/cli/sync-agents.js
/**
 * `mandrel sync-agents`: project `.agents/agents/` into `.claude/agents/` via
 * `.agents/scripts/sync-claude-agents.js`. Exact sibling of
 * `sync-commands.js` — same child-process delegation, same marker-gated
 * refusal and anchor rule (see that module's doc).
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
  'sync-claude-agents.js',
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
        `mandrel sync-agents: the materialized .agents/ tree is v${marker} but the running CLI is v${resolvedOwnVersion} — refusing to project .claude/agents/ from a mismatched tree.\n` +
          '   → Run `mandrel sync` to re-materialize .agents/ to the current version, then re-run.\n',
      );
      exit(1);
      return;
    }
  } else {
    const drift = (checkAgentsDrift ?? (() => runAgentsDrift({ cwd })))();
    if (!drift.ok) {
      writeErr(
        `mandrel sync-agents: .agents/ appears to have drifted from the installed package payload (${drift.detail}) — refusing to project .claude/agents/ from a mismatched tree.\n` +
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
