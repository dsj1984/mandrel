#!/usr/bin/env node

/**
 * Projects .agents/agents/ (and .agents/local/agents/ when present) into a flat
 * `.claude/agents/` tree so Claude Code exposes each role definition as a
 * role-scoped sub-agent (`subagent_type: <name>`). Exact sibling of
 * `sync-claude-commands.js` — same header, same local-shadow policy, same
 * orphan-reap, same prune-exempt handling for the consumer-authored
 * `.agents/local/agents/` source. Two source directories are enumerated in
 * order:
 *
 *   1. PAYLOAD_SRC  — `.agents/agents/`  (the installed Mandrel payload)
 *   2. LOCAL_SRC    — `.agents/local/agents/`  (consumer-authored, prune-exempt)
 *
 * The payload directory wins on basename collision: if both sources supply
 * `foo.md`, the payload copy is projected and the local copy is ignored with a
 * `shadowed` warning. Because both sources are unioned into `sourceSet`, local
 * agent defs are also protected from the orphan-reap — they survive
 * `npm install`, `mandrel sync`, and `mandrel update` with no manual re-sync.
 *
 * Only top-level `.md` files project (`.claude/agents/<name>.md`). Unlike the
 * commands sync there is no `loops/` namespace and no plugin tree to reap — the
 * agent surface is flat.
 *
 * A `.claude/agents/<name>.md` runs on its **own** system prompt — it does NOT
 * inherit the `CLAUDE.md` @-import closure — so a spawn routed to a role agent
 * stops re-paying the always-loaded context (issue #4478). The role defs
 * @-import `security-baseline.md` so the inviolable security MUSTs stay
 * single-sourced.
 *
 * Usage:  node .agents/scripts/sync-claude-agents.js
 */

// cli-opt-out: top-level-await script with no main() function — runAsCli wraps an async main, which doesn't apply here.
import fs from 'node:fs';
import path from 'node:path';

import { applyHeader } from './lib/command-header.js';
import { Logger } from './lib/Logger.js';

// Resolve the project root from the invocation cwd — the consumer project where
// `.agents/` is materialized and where Claude Code loads `.claude/agents/`.
// It MUST NOT use `__dirname/../..`: in an npm-installed consumer this script
// runs from `node_modules/mandrel/.agents/scripts/`, so that climb lands on the
// package dir and the defs would be written *inside node_modules* rather than
// the consumer. Every real invocation runs with cwd at the project root
// (`npm run sync:agents`, the prepare hook). Tests drive fixture trees via the
// SYNC_CLAUDE_AGENTS_SRC/DEST overrides below.
const PROJECT_ROOT = process.cwd();

// Env-var overrides exist so the sync logic can be exercised against a fixture
// agents tree in isolation. When unset, behaviour is unchanged — the script
// defaults to the real agents / .claude/agents directories. SYNC_CLAUDE_AGENTS_SRC
// overrides the PAYLOAD source only; LOCAL_SRC is always derived from the project
// root so fixture tests can isolate the payload source.
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

fs.mkdirSync(DEST_DIR, { recursive: true });

// Top-level .md files project flat. Subdirectories are skipped.
const isTopLevelAgent = (entry) => entry.isFile() && entry.name.endsWith('.md');

// Enumerate sources: payload first, then local (if it exists). Payload wins on
// basename collision — a consumer must not silently shadow a core role def.
const SRC_DIRS = [PAYLOAD_SRC, LOCAL_SRC].filter(dirExists);

/** @type {Array<{dir: string, name: string}>} */
const entries = SRC_DIRS.flatMap((dir) =>
  fs
    .readdirSync(dir, { withFileTypes: true })
    .filter(isTopLevelAgent)
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

// sourceSet drives the orphan-reap: any existing agent def not in this set is
// removed.
const sourceSet = new Set(byName.keys());

/**
 * List the `.md` agent defs currently on disk in the destination.
 *
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

// Copy each role def, injecting the auto-generated header after any leading
// frontmatter (so the `---` block stays on line 1 and Claude Code parses the
// agent's name/description). Use a distinct header comment for local-origin files.
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
