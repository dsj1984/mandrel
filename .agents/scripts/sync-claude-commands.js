#!/usr/bin/env node

/**
 * Projects .agents/workflows/ into a Claude Code **plugin** so every workflow
 * is invocable as `/mandrel:<name>` rather than a bare `/<name>` project
 * command. The workflows directory remains the single source of truth; this
 * script is the only writer of the generated plugin tree.
 *
 * Hard cutover (Story #3576): this replaces the previous flat
 * `.claude/commands/` projection. The plugin lives under
 * `.claude/plugins/mandrel/` so it is NOT picked up as a bare project-command
 * surface — there is exactly one projection (the plugin), and the old
 * `/epic-deliver`-style bare commands no longer appear in the `/` menu. The
 * brand appears once, as the `mandrel:` namespace; per-command names stay
 * descriptive (supersedes ADR 20260513 on the collision axis only).
 *
 * Output layout (plugin root = `.claude/plugins/mandrel/`):
 *
 *   .claude/
 *   ├── .claude-plugin/
 *   │   └── marketplace.json     # repo-local marketplace listing the plugin
 *   └── plugins/
 *       └── mandrel/
 *           ├── .claude-plugin/
 *           │   └── plugin.json  # name: "mandrel", version from package.json
 *           └── commands/
 *               └── <name>.md    # one per top-level workflow
 *
 * Only top-level .md files are projected. The `.agents/workflows/helpers/`
 * subdirectory holds path-included modules (e.g. epic-code-review,
 * epic-retro) that parent workflows read by relative path — they are
 * intentionally **not** exposed as commands, so helpers/ is skipped.
 *
 * Usage:  node .agents/scripts/sync-claude-commands.js
 */

// cli-opt-out: top-level-await script with no main() function — runAsCli wraps an async main, which doesn't apply here.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Logger } from './lib/Logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '../..');

/** Plugin manifest name — the `mandrel:` namespace every command gets. */
export const PLUGIN_NAME = 'mandrel';

/**
 * Marketplace name used to register the repo-local plugin. The enabledPlugins
 * key a consumer writes is `<PLUGIN_NAME>@<MARKETPLACE_NAME>`.
 */
export const MARKETPLACE_NAME = 'mandrel';

/**
 * Plugin output root, relative to PROJECT_ROOT. The plugin lives under
 * `.claude/plugins/mandrel/` rather than `.claude/commands/` so Claude Code
 * loads it through the plugin system (namespaced) instead of as bare project
 * commands (un-namespaced) — that nesting is what makes the cutover a true
 * replacement rather than a coexistence.
 */
export const PLUGIN_DIR_REL = path.join('.claude', 'plugins', PLUGIN_NAME);

// Env-var overrides exist so the sync logic can be exercised against a
// fixture workflow tree in isolation (regression test for the Epic #1185
// frontmatter pass-through contract). When unset, behaviour is unchanged
// — the script defaults to the real workflows / plugin directories.
const SRC_DIR =
  process.env.SYNC_CLAUDE_COMMANDS_SRC ??
  path.join(PROJECT_ROOT, '.agents', 'workflows');

// SYNC_CLAUDE_COMMANDS_DEST overrides the plugin **root** (the directory that
// holds `.claude-plugin/plugin.json` and `commands/`). The marketplace file is
// written one level up from `plugins/`, mirroring the real
// `.claude/.claude-plugin/marketplace.json` ↔ `.claude/plugins/mandrel/`
// layout where the marketplace root is `.claude/`.
const PLUGIN_ROOT =
  process.env.SYNC_CLAUDE_COMMANDS_DEST ??
  path.join(PROJECT_ROOT, PLUGIN_DIR_REL);

const COMMANDS_DIR = path.join(PLUGIN_ROOT, 'commands');
const PLUGIN_MANIFEST_DIR = path.join(PLUGIN_ROOT, '.claude-plugin');
const PLUGIN_MANIFEST_PATH = path.join(PLUGIN_MANIFEST_DIR, 'plugin.json');
// The marketplace root is the directory that contains `plugins/` — two levels
// above the plugin root (`<root>/plugins/mandrel`). Its `.claude-plugin/`
// holds the marketplace listing.
const MARKETPLACE_PATH = path.join(
  PLUGIN_ROOT,
  '..',
  '..',
  '.claude-plugin',
  'marketplace.json',
);

export const HEADER =
  '<!-- AUTO-GENERATED — do not edit. Source of truth: .agents/workflows/ -->\n<!-- Re-run: npm run sync:commands -->\n\n';

/**
 * Read the framework version from the root package.json so the plugin version
 * tracks the framework release. Falls back to `0.0.0` if the manifest is
 * unreadable (e.g. an isolated fixture tree under SYNC_CLAUDE_COMMANDS_DEST).
 *
 * @returns {string}
 */
function readFrameworkVersion() {
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf8'),
    );
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/**
 * Build the plugin manifest object. `name` is the only required field and is
 * what Claude Code uses to namespace commands as `/mandrel:<name>`.
 *
 * @param {string} version
 * @returns {object}
 */
export function buildPluginManifest(version) {
  return {
    name: PLUGIN_NAME,
    description:
      'Mandrel SDLC workflows — epic/story delivery, audits, and git automation, namespaced as /mandrel:<command>.',
    version,
  };
}

/**
 * Build the repo-local marketplace object that registers the plugin from a
 * relative path within the repository (no hosted marketplace required). The
 * `source` path resolves relative to the marketplace root (the directory that
 * contains `.claude-plugin/`), so `./plugins/mandrel` points at the plugin root.
 *
 * @returns {object}
 */
export function buildMarketplace() {
  return {
    name: MARKETPLACE_NAME,
    owner: { name: 'Mandrel' },
    plugins: [
      {
        name: PLUGIN_NAME,
        source: `./plugins/${PLUGIN_NAME}`,
        description:
          'Mandrel SDLC workflow commands projected from .agents/workflows/.',
      },
    ],
  };
}

/**
 * Write `obj` as pretty-printed JSON only when the on-disk content differs,
 * to avoid noisy git diffs on idempotent re-runs. Returns true when written.
 *
 * @param {string} dest
 * @param {object} obj
 * @returns {boolean}
 */
function writeJsonIfChanged(dest, obj) {
  const target = `${JSON.stringify(obj, null, 2)}\n`;
  try {
    if (fs.readFileSync(dest, 'utf8') === target) return false;
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, target, 'utf8');
  return true;
}

/**
 * Reap the legacy flat `.claude/commands/` projection (the pre-#3576 surface)
 * so the bare `/<name>` commands stop appearing alongside the namespaced
 * `/mandrel:<name>` plugin commands. This is the hard-cutover step on existing
 * machines: the directory is no longer written, but a developer who synced
 * before the cutover still has stale bare-command files on disk that Claude
 * Code would keep loading. We delete the generated `.md` files (each carries
 * the AUTO-GENERATED header so we never touch a hand-authored command) and
 * remove the directory when it ends up empty.
 *
 * Skipped when the plugin root is overridden for fixture isolation
 * (SYNC_CLAUDE_COMMANDS_DEST set) so a test tree never reaches into a real
 * project's `.claude/commands/`.
 */
function reapLegacyFlatCommands() {
  if (process.env.SYNC_CLAUDE_COMMANDS_DEST) return;
  const legacyDir = path.join(PROJECT_ROOT, '.claude', 'commands');
  let entries;
  try {
    entries = fs.readdirSync(legacyDir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return;
    throw err;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    const filePath = path.join(legacyDir, entry.name);
    // Only remove generated files (carrying the AUTO-GENERATED header); leave
    // any hand-authored command untouched.
    if (fs.readFileSync(filePath, 'utf8').startsWith('<!-- AUTO-GENERATED')) {
      fs.unlinkSync(filePath);
      Logger.info(`  reaped   .claude/commands/${entry.name} (flat → plugin)`);
    }
  }
  try {
    fs.rmdirSync(legacyDir);
  } catch {
    // Directory not empty (a hand-authored command remains) or already gone.
  }
}

reapLegacyFlatCommands();

fs.mkdirSync(COMMANDS_DIR, { recursive: true });

// Only project top-level .md files. Subdirectories (notably helpers/) are
// ignored — they contain path-included modules, not commands.
const isTopLevelWorkflow = (entry) =>
  entry.isFile() && entry.name.endsWith('.md');

const existing = fs.readdirSync(COMMANDS_DIR).filter((f) => f.endsWith('.md'));
const sources = fs
  .readdirSync(SRC_DIR, { withFileTypes: true })
  .filter(isTopLevelWorkflow)
  .map((entry) => entry.name);
const sourceSet = new Set(sources);

// Prune command files whose source workflow no longer exists.
for (const file of existing) {
  if (!sourceSet.has(file)) {
    fs.unlinkSync(path.join(COMMANDS_DIR, file));
    Logger.info(`  removed  ${file} (no longer in workflows)`);
  }
}

// Project each workflow into the plugin command tree, prepending the
// auto-generated header. Parallelised so the ~30-file sync doesn't serialise
// on per-file fs latency (noticeable on Windows where each syscall pays a
// larger fixed cost).
let synced = 0;
await Promise.all(
  sources.map(async (file) => {
    const content = await fs.promises.readFile(
      path.join(SRC_DIR, file),
      'utf8',
    );
    const dest = path.join(COMMANDS_DIR, file);
    const target = HEADER + content;

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
    Logger.info(`  synced   ${file}`);
  }),
);

// Write the plugin manifest and the repo-local marketplace listing.
if (
  writeJsonIfChanged(
    PLUGIN_MANIFEST_PATH,
    buildPluginManifest(readFrameworkVersion()),
  )
) {
  Logger.info('  wrote    plugins/mandrel/.claude-plugin/plugin.json');
}
if (writeJsonIfChanged(MARKETPLACE_PATH, buildMarketplace())) {
  Logger.info('  wrote    .claude/.claude-plugin/marketplace.json');
}

Logger.info(
  `\n✔ ${synced} file(s) synced, ${sources.length} total commands in the mandrel plugin (/mandrel:<name>).`,
);
