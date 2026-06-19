#!/usr/bin/env node

/**
 * Projects .agents/workflows/ (and .agents/local/workflows/ when present) into
 * a flat `.claude/commands/` tree so Claude Code exposes each workflow as a
 * bare `/<name>` slash command. Two source directories are enumerated in order:
 *
 *   1. PAYLOAD_SRC  — `.agents/workflows/`  (the installed Mandrel payload)
 *   2. LOCAL_SRC    — `.agents/local/workflows/`  (consumer-authored, prune-exempt)
 *
 * The payload directory wins on basename collision: if both sources supply
 * `foo.md`, the payload copy is projected and the local copy is ignored with a
 * `shadowed` warning. Because both sources are unioned into `sourceSet`, local
 * commands are also protected from the orphan-reap — they survive
 * `npm install`, `mandrel sync`, and `mandrel update` with no manual re-sync.
 *
 * Flat projection (reverts the #3576 plugin cutover): the plugin command tree
 * (`.claude/plugins/mandrel/`) and the repo-local marketplace
 * (`.claude/.claude-plugin/marketplace.json`) are NOT written, because the
 * plugin system is unavailable in some Claude Code environments (`/plugin` not
 * present), which left the namespaced `/mandrel:<name>` commands unreachable.
 * Flat `.claude/commands/*.md` is the surface that loads across every
 * environment (CLI, IDE, GUI, web, SDK). On a machine that previously synced
 * the plugin tree, this script reaps it on the next run (see reapPluginTree).
 *
 * Only top-level .md files are projected. The `.agents/workflows/helpers/`
 * subdirectory holds path-included modules (e.g. epic-code-review, epic-retro)
 * that parent workflows read by relative path — they are intentionally **not**
 * exposed as commands, so helpers/ is skipped.
 *
 * Usage:  node .agents/scripts/sync-claude-commands.js
 */

// cli-opt-out: top-level-await script with no main() function — runAsCli wraps an async main, which doesn't apply here.
import fs from 'node:fs';
import path from 'node:path';

import { applyHeader } from './lib/command-header.js';
import { Logger } from './lib/Logger.js';

// Resolve the project root from the invocation cwd — the consumer project where
// `.agents/` is materialized and where Claude Code loads `.claude/commands/`.
// It MUST NOT use `__dirname/../..`: in an npm-installed consumer this script
// runs from `node_modules/mandrel/.agents/scripts/`, so that climb
// lands on the package dir and the commands would be written *inside
// node_modules* rather than the consumer — leaving `/<name>` commands
// unloadable and the `commands-in-sync` doctor check (which resolves the same
// consumer root via cwd — Story #3588) reporting "N not synced". Every real
// invocation runs with cwd at the project root: `npm run sync:commands`, the
// UserPromptSubmit hook, and `mandrel sync-commands` (which inherits the
// caller's cwd). Tests drive fixture trees via the SYNC_CLAUDE_COMMANDS_SRC/DEST
// overrides below.
const PROJECT_ROOT = process.cwd();

// Env-var overrides exist so the sync logic can be exercised against a
// fixture workflow tree in isolation (regression test for the Epic #1185
// frontmatter pass-through contract). When unset, behaviour is unchanged
// — the script defaults to the real workflows / commands directories.
// SYNC_CLAUDE_COMMANDS_SRC overrides the PAYLOAD source only; the LOCAL_SRC
// is always derived from the project root so fixture tests can isolate the
// payload source while still allowing LOCAL_SRC to be present if needed.
const PAYLOAD_SRC =
  process.env.SYNC_CLAUDE_COMMANDS_SRC ??
  path.join(PROJECT_ROOT, '.agents', 'workflows');
const LOCAL_SRC = path.join(PROJECT_ROOT, '.agents', 'local', 'workflows');

const DEST_DIR =
  process.env.SYNC_CLAUDE_COMMANDS_DEST ??
  path.join(PROJECT_ROOT, '.claude', 'commands');

export const HEADER =
  '<!-- AUTO-GENERATED — do not edit. Source of truth: .agents/workflows/ -->\n<!-- Re-run: npm run sync:commands -->\n\n';

export const LOCAL_HEADER =
  '<!-- AUTO-GENERATED from .agents/local/ — do not edit. Source of truth: .agents/local/workflows/ -->\n<!-- Re-run: npm run sync:commands -->\n\n';

/**
 * Return true when the given directory path exists and is accessible.
 *
 * @param {string} dir
 * @returns {boolean}
 */
function dirExists(dir) {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Reap the generated plugin projection (the #3576 surface) so the namespaced
 * `/mandrel:<name>` commands and the repo-local marketplace stop shadowing the
 * flat `/<name>` commands. This is the cutover-back step on existing machines:
 * the plugin tree is no longer written, but a developer who synced under #3576
 * still has it on disk. Removing `.claude/plugins/mandrel/` and the marketplace
 * listing is idempotent and never blocks the flat sync.
 *
 * Skipped when SYNC_CLAUDE_COMMANDS_DEST is set (fixture runs own their tree).
 *
 * @returns {void}
 */
function reapPluginTree() {
  if (process.env.SYNC_CLAUDE_COMMANDS_DEST) return;
  const pluginRoot = path.join(PROJECT_ROOT, '.claude', 'plugins', 'mandrel');
  const marketplace = path.join(
    PROJECT_ROOT,
    '.claude',
    '.claude-plugin',
    'marketplace.json',
  );
  for (const target of [pluginRoot, marketplace]) {
    try {
      fs.rmSync(target, { recursive: true, force: true });
    } catch (err) {
      Logger.warn(`  skip reap ${target}: ${err.message}`);
    }
  }
  // Remove the now-empty .claude-plugin/ dir (ignore if absent or non-empty).
  try {
    fs.rmdirSync(path.join(PROJECT_ROOT, '.claude', '.claude-plugin'));
  } catch {
    /* not empty or absent — leave it */
  }
}

reapPluginTree();
fs.mkdirSync(DEST_DIR, { recursive: true });

// Only sync top-level .md files. Subdirectories (notably helpers/) are
// ignored — they contain path-included modules, not slash commands.
const isTopLevelWorkflow = (entry) =>
  entry.isFile() && entry.name.endsWith('.md');

// Enumerate sources: payload first, then local (if it exists). Payload wins
// on basename collision — a consumer must not silently shadow a core command.
const SRC_DIRS = [PAYLOAD_SRC, LOCAL_SRC].filter(dirExists);

/** @type {Array<{dir: string, name: string}>} */
const entries = SRC_DIRS.flatMap((dir) =>
  fs
    .readdirSync(dir, { withFileTypes: true })
    .filter(isTopLevelWorkflow)
    .map((e) => ({ dir, name: e.name })),
);

// Collision policy: payload wins, warn on a shadowed local file.
const byName = new Map();
for (const e of entries) {
  if (byName.has(e.name)) {
    Logger.warn(`  shadowed  ${e.name} (local copy ignored; payload wins)`);
    continue;
  }
  byName.set(e.name, e);
}

// sourceSet drives the orphan-reap: any existing command not in this set is
// removed. Local-projected commands are included, so they survive the reap.
const sourceSet = new Set(byName.keys());

const existing = fs.readdirSync(DEST_DIR).filter((f) => f.endsWith('.md'));

for (const file of existing) {
  if (!sourceSet.has(file)) {
    fs.unlinkSync(path.join(DEST_DIR, file));
    Logger.info(`  removed  ${file} (no longer in workflows)`);
  }
}

// Copy each workflow, injecting the auto-generated header after any leading
// frontmatter (so the `---` block stays on line 1 and Claude Code parses the
// command description). Use a distinct header comment for local-origin files.
// Parallelised so the ~30-file sync doesn't serialise on per-file fs latency
// (noticeable on Windows where each syscall pays a larger fixed cost).
let synced = 0;
const resolvedEntries = Array.from(byName.values());
await Promise.all(
  resolvedEntries.map(async ({ dir, name }) => {
    const isLocal = dir === LOCAL_SRC;
    const header = isLocal ? LOCAL_HEADER : HEADER;
    const content = await fs.promises.readFile(path.join(dir, name), 'utf8');
    const dest = path.join(DEST_DIR, name);
    const target = applyHeader(content, header);

    // Skip write if content is already identical (avoid noisy git diffs).
    // Use try/catch over existsSync+readFile so we only pay one syscall.
    try {
      const existingContent = await fs.promises.readFile(dest, 'utf8');
      if (existingContent === target) return;
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }

    await fs.promises.writeFile(dest, target, 'utf8');
    synced++;
    Logger.info(`  synced   ${name}`);
  }),
);

Logger.info(
  `\n✔ ${synced} file(s) synced, ${sourceSet.size} total commands in .claude/commands/`,
);
