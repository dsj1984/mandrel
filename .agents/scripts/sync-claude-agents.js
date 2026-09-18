#!/usr/bin/env node

/**
 * Project `.agents/agents/` and `.agents/local/agents/` into a flat
 * `.claude/agents/` tree — the sibling of `sync-claude-commands.js`, with the
 * same payload-wins shadowing and orphan-reap. A role agent runs on its own
 * system prompt (no `CLAUDE.md` closure), which is the point of routing to it.
 */

// cli-opt-out: top-level-await script with no main() function — runAsCli wraps an async main, which doesn't apply here.
import fs from 'node:fs';
import path from 'node:path';

import { applyHeader } from './lib/command-header.js';
import { Logger } from './lib/Logger.js';

// cwd, never `__dirname/../..`, which lands inside node_modules when installed.
const PROJECT_ROOT = process.cwd();

// Test overrides; SYNC_CLAUDE_AGENTS_SRC replaces the payload source only.
const PAYLOAD_SRC =
  process.env.SYNC_CLAUDE_AGENTS_SRC ??
  path.join(PROJECT_ROOT, '.agents', 'agents');
const LOCAL_SRC = path.join(PROJECT_ROOT, '.agents', 'local', 'agents');

const DEST_DIR =
  process.env.SYNC_CLAUDE_AGENTS_DEST ??
  path.join(PROJECT_ROOT, '.claude', 'agents');

export const HEADER =
  '<!-- AUTO-GENERATED — do not edit. Source of truth: .agents/agents/ -->\n<!-- Re-run: npm run sync:agents -->\n\n';

export const LOCAL_HEADER =
  '<!-- AUTO-GENERATED from .agents/local/ — do not edit. Source of truth: .agents/local/agents/ -->\n<!-- Re-run: npm run sync:agents -->\n\n';

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

fs.mkdirSync(DEST_DIR, { recursive: true });

const isTopLevelAgent = (entry) => entry.isFile() && entry.name.endsWith('.md');

// Payload first, so it wins a collision.
const SRC_DIRS = [PAYLOAD_SRC, LOCAL_SRC].filter(dirExists);

/** @type {Array<{dir: string, name: string}>} */
const entries = SRC_DIRS.flatMap((dir) =>
  fs
    .readdirSync(dir, { withFileTypes: true })
    .filter(isTopLevelAgent)
    .map((e) => ({ dir, name: e.name })),
);

const byName = new Map();
for (const e of entries) {
  if (byName.has(e.name)) {
    Logger.warn(`  shadowed  ${e.name} (local copy ignored; payload wins)`);
    continue;
  }
  byName.set(e.name, e);
}

// Any existing agent def not in this set is reaped.
const sourceSet = new Set(byName.keys());

/**
 * @returns {string[]}
 */
function listExistingAgents() {
  try {
    return fs.readdirSync(DEST_DIR).filter((f) => f.endsWith('.md'));
  } catch {
    return [];
  }
}

for (const name of listExistingAgents()) {
  if (!sourceSet.has(name)) {
    fs.unlinkSync(path.join(DEST_DIR, name));
    Logger.info(`  removed  ${name} (no longer in .agents/agents)`);
  }
}

// The header goes after any frontmatter, so `---` stays on line 1.
let synced = 0;
const resolvedEntries = Array.from(byName.values());
await Promise.all(
  resolvedEntries.map(async ({ dir, name }) => {
    const isLocal = dir === LOCAL_SRC;
    const header = isLocal ? LOCAL_HEADER : HEADER;
    const content = await fs.promises.readFile(path.join(dir, name), 'utf8');
    const dest = path.join(DEST_DIR, name);
    const target = applyHeader(content, header);

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
  `\n✔ ${synced} file(s) synced, ${sourceSet.size} total agents in .claude/agents/`,
);
