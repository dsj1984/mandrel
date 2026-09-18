#!/usr/bin/env node

/**
 * Project `.agents/workflows/` and `.agents/local/workflows/` into a flat
 * `.claude/commands/` tree (one `/<name>` per top-level workflow). The payload
 * wins a name collision; both sources feed the orphan-reap set, so local
 * commands survive re-syncs. Flat commands, not a plugin tree, because the
 * plugin system is unavailable in some Claude Code hosts. `helpers/` is not
 * projected; `loops/` is the one recursed subdirectory (`/loops:<name>`).
 */

// cli-opt-out: top-level-await script with no main() function — runAsCli wraps an async main, which doesn't apply here.
import fs from 'node:fs';
import path from 'node:path';

import { applyHeader, isCommandExcluded } from './lib/command-header.js';
import { Logger } from './lib/Logger.js';

// The root is cwd, never `__dirname/../..`: installed under node_modules that
// climb lands on the package dir and would write commands inside it.
const PROJECT_ROOT = process.cwd();

// Test overrides; SYNC_CLAUDE_COMMANDS_SRC replaces the payload source only.
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
 * Remove any on-disk plugin projection and marketplace listing, which would
 * shadow the flat commands. Idempotent; skipped for fixture runs.
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
  try {
    fs.rmdirSync(path.join(PROJECT_ROOT, '.claude', '.claude-plugin'));
  } catch {
    /* not empty or absent — leave it */
  }
}

reapPluginTree();
fs.mkdirSync(DEST_DIR, { recursive: true });

// The only recursed subdirectory; helpers/ holds path-included modules.
const LOOPS_NS = 'loops';

const isTopLevelWorkflow = (entry) =>
  entry.isFile() && entry.name.endsWith('.md');

/**
 * `loops/README.md` is documentation, not a command.
 *
 * @param {import('node:fs').Dirent} entry
 * @returns {boolean}
 */
const isLoopUnit = (entry) =>
  isTopLevelWorkflow(entry) && entry.name.toLowerCase() !== 'readme.md';

/**
 * Keyed by `loops/<name>.md` so a unit never collides with a flat command.
 *
 * @param {string} dir A workflows source root.
 * @returns {Array<{dir: string, name: string, rel: string}>}
 */
function enumerateLoopUnits(dir) {
  const loopsDir = path.join(dir, LOOPS_NS);
  if (!dirExists(loopsDir)) return [];
  return fs
    .readdirSync(loopsDir, { withFileTypes: true })
    .filter(isLoopUnit)
    .map((e) => ({
      dir,
      name: e.name,
      rel: `${LOOPS_NS}/${e.name}`,
    }));
}

// Payload first, so it wins a collision.
const SRC_DIRS = [PAYLOAD_SRC, LOCAL_SRC].filter(dirExists);

/** @type {Array<{dir: string, name: string, rel: string}>} */
const entries = SRC_DIRS.flatMap((dir) => [
  ...fs
    .readdirSync(dir, { withFileTypes: true })
    .filter(isTopLevelWorkflow)
    .map((e) => ({ dir, name: e.name, rel: e.name })),
  ...enumerateLoopUnits(dir),
]);

// A `command: false` workflow never enters `sourceSet`, so a stale copy is reaped.
const byRel = new Map();
for (const e of entries) {
  if (byRel.has(e.rel)) {
    Logger.warn(`  shadowed  ${e.rel} (local copy ignored; payload wins)`);
    continue;
  }
  if (isCommandExcluded(fs.readFileSync(path.join(e.dir, e.rel), 'utf8'))) {
    Logger.info(`  excluded ${e.rel} (frontmatter command: false)`);
    continue;
  }
  byRel.set(e.rel, e);
}

// Any existing command not in this set is reaped.
const sourceSet = new Set(byRel.keys());

/**
 * @returns {string[]}
 */
function listExistingCommands() {
  const flat = fs
    .readdirSync(DEST_DIR)
    .filter((f) => f.endsWith('.md'))
    .map((f) => f);
  const loopsDest = path.join(DEST_DIR, LOOPS_NS);
  const loops = dirExists(loopsDest)
    ? fs
        .readdirSync(loopsDest)
        .filter((f) => f.endsWith('.md'))
        .map((f) => `${LOOPS_NS}/${f}`)
    : [];
  return [...flat, ...loops];
}

for (const rel of listExistingCommands()) {
  if (!sourceSet.has(rel)) {
    fs.unlinkSync(path.join(DEST_DIR, rel));
    Logger.info(`  removed  ${rel} (no longer in workflows)`);
  }
}

// The header goes after any frontmatter, so `---` stays on line 1.
let synced = 0;
const resolvedEntries = Array.from(byRel.values());
await Promise.all(
  resolvedEntries.map(async ({ dir, rel }) => {
    const isLocal = dir === LOCAL_SRC;
    const header = isLocal ? LOCAL_HEADER : HEADER;
    const content = await fs.promises.readFile(path.join(dir, rel), 'utf8');
    const dest = path.join(DEST_DIR, rel);
    const target = applyHeader(content, header);

    await fs.promises.mkdir(path.dirname(dest), { recursive: true });

    // Skip identical content to avoid noisy git diffs.
    try {
      const existingContent = await fs.promises.readFile(dest, 'utf8');
      if (existingContent === target) return;
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }

    await fs.promises.writeFile(dest, target, 'utf8');
    synced++;
    Logger.info(`  synced   ${rel}`);
  }),
);

Logger.info(
  `\n✔ ${synced} file(s) synced, ${sourceSet.size} total commands in .claude/commands/`,
);
