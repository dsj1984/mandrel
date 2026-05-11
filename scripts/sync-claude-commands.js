#!/usr/bin/env node

/**
 * Syncs .agents/workflows/ → .claude/commands/ so Claude Code exposes each
 * workflow as a slash command.  The workflows directory remains the single
 * source of truth; this script is the only writer of .claude/commands/.
 *
 * Only top-level .md files are synced. The `.agents/workflows/helpers/`
 * subdirectory holds path-included modules (e.g. epic-code-review,
 * epic-retro) that parent workflows read by relative path — they are
 * intentionally **not** exposed as slash commands, so helpers/ is skipped.
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

// Env-var overrides exist so the sync logic can be exercised against a
// fixture workflow tree in isolation (regression test for the Epic #1185
// frontmatter pass-through contract). When unset, behaviour is unchanged
// — the script defaults to the real workflows / commands directories.
const SRC_DIR =
  process.env.SYNC_CLAUDE_COMMANDS_SRC ??
  path.join(PROJECT_ROOT, '.agents', 'workflows');
const DEST_DIR =
  process.env.SYNC_CLAUDE_COMMANDS_DEST ??
  path.join(PROJECT_ROOT, '.claude', 'commands');

const HEADER =
  '<!-- AUTO-GENERATED — do not edit. Source of truth: .agents/workflows/ -->\n<!-- Re-run: npm run sync:commands -->\n\n';

fs.mkdirSync(DEST_DIR, { recursive: true });

// Only sync top-level .md files. Subdirectories (notably helpers/) are
// ignored — they contain path-included modules, not slash commands.
const isTopLevelWorkflow = (entry) =>
  entry.isFile() && entry.name.endsWith('.md');

const existing = fs.readdirSync(DEST_DIR).filter((f) => f.endsWith('.md'));
const sources = fs
  .readdirSync(SRC_DIR, { withFileTypes: true })
  .filter(isTopLevelWorkflow)
  .map((entry) => entry.name);
const sourceSet = new Set(sources);

for (const file of existing) {
  if (!sourceSet.has(file)) {
    fs.unlinkSync(path.join(DEST_DIR, file));
    Logger.info(`  removed  ${file} (no longer in workflows)`);
  }
}

// Copy each workflow, prepending the auto-generated header. Parallelised so
// the 27-file sync doesn't serialise on per-file fs latency (noticeable on
// Windows where each syscall pays a larger fixed cost).
let synced = 0;
await Promise.all(
  sources.map(async (file) => {
    const content = await fs.promises.readFile(
      path.join(SRC_DIR, file),
      'utf8',
    );
    const dest = path.join(DEST_DIR, file);
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

Logger.info(
  `\n✔ ${synced} file(s) synced, ${sources.length} total commands in .claude/commands/`,
);
