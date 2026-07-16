// lib/cli/sync-agents.js
/**
 * `mandrel sync-agents` subcommand (Story #4528 / #4530).
 *
 * Thin wrapper that delegates to the canonical sync script
 * (.agents/scripts/sync-claude-agents.js), projecting `.agents/agents/` into
 * a flat `.claude/agents/` tree. Exact sibling of `sync-commands.js` —
 * same delegation shape, same marker-gated refusal check, same seams —
 * targeting the role-agent tree instead of the command tree. The sync
 * script owns all sync logic; this module exists only to expose it through
 * the mandrel CLI surface without reimplementing it.
 *
 * `sync-claude-agents.js` uses top-level await and has no exported `main()`
 * function (marked `cli-opt-out`), so delegation runs via a child process
 * rather than a direct import. Exit code and all output are forwarded
 * verbatim to the caller so `mandrel sync-agents` is transparent to scripts
 * that check $?.
 *
 * ## Prior to this Story
 *
 * `sync-claude-agents.js` was invoked on the **bootstrap** path
 * (`project-bootstrap.js`'s `sync:agents` script, `prepare`, and
 * `runSyncCommands`) but had no `lib/cli/` subcommand counterpart and was
 * never run by `mandrel sync` / `mandrel update` on the CLI path — the gap
 * #4528 reported. See `update.js`'s `driftHealSteps()` /
 * `fullUpgradeSteps()`, which now spawn a `sync-agents` phase alongside
 * `sync-commands` so `.claude/agents/` materializes on that path too.
 *
 * ## Marker-gated refusal (Story #4526 / #4530) — same shape as sync-commands
 *
 * Before delegating, this wrapper checks whether the `.agents/` tree it is
 * about to project agents FROM actually matches the running CLI's own
 * payload version, exactly as `sync-commands.js` does for the command tree.
 * See that module's doc comment for the full rationale and the anchor-trap
 * warning — it applies identically here (`PROJECT_ROOT` is deliberately the
 * package root, used only to read the running CLI's OWN version; the marker
 * read is anchored at `cwd()`, never at `PROJECT_ROOT`).
 *
 * Gate order:
 *   1. Marker present (`.agents/.mandrel-version`) → compare it to the
 *      running CLI's own package version. Mismatch → refuse.
 *   2. Marker absent (a pre-marker install) → fall back to the existing
 *      `agents-drift` content-hash check. Drift detected → refuse.
 *   3. Clean either way → project as before.
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
 * Resolve the running CLI's own package version from `PROJECT_ROOT`'s
 * `package.json`. See `sync-commands.js`'s "anchor trap" module doc: this is
 * the ONE place `PROJECT_ROOT` (the package's own two-dirs-up root) is the
 * correct anchor.
 *
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
 * Run the sync-claude-agents script and forward its output + exit code —
 * unless the marker-gated refusal check (see module doc) finds the
 * `.agents/` tree mismatched against the running CLI, in which case it
 * refuses and exits non-zero before spawning anything.
 *
 * Injectable seams — identical shape to `sync-commands.js`:
 * - `runner` — replaces `spawnSync` for the real delegation.
 * - `cwd()` — replaces `process.cwd`; anchors the marker read at the
 *   consumer project root.
 * - `fs` — replaces the `node:fs` surface for both the marker read and the
 *   own-version read.
 * - `ownVersion` — overrides the running CLI's own resolved version
 *   directly, bypassing `resolveOwnPackageVersion`.
 * - `checkAgentsDrift` — overrides the fallback drift probe used when the
 *   marker is absent; defaults to `runAgentsDrift({ cwd })`.
 * - `writeErr` / `exit` — replace the corresponding process surfaces.
 *
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
