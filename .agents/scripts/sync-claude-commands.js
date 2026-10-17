#!/usr/bin/env node

/** Project the workflow set for Claude, then Codex, from `process.cwd()`. */

import {
  CLAUDE_COMMANDS_DIR,
  syncClaudeCommands,
} from './lib/claude/commands-projection.js';
import { runAsCli } from './lib/cli-utils.js';
import {
  CODEX_SKILLS_DIR,
  syncCodexSkills,
} from './lib/codex/skills-projection.js';
import { Logger } from './lib/Logger.js';

/** @returns {Promise<void>} */
async function main() {
  // cwd, never `__dirname/../..`, which lands inside node_modules.
  const projectRoot = process.cwd();
  const log = (line) => Logger.info(line);
  const claude = syncClaudeCommands({
    projectRoot,
    log,
    warn: (line) => Logger.warn(line),
  });
  Logger.info(
    `\n✔ ${claude.written.length} file(s) synced, ${claude.total} total commands in ${CLAUDE_COMMANDS_DIR}/`,
  );
  const codex = syncCodexSkills({ projectRoot, log });
  Logger.info(
    `✔ ${codex.written.length} file(s) synced, ${codex.total} total Codex skills in ${CODEX_SKILLS_DIR}/`,
  );
}

runAsCli(import.meta.url, main, {
  source: 'sync-claude-commands',
  usage: {
    invocation: 'node .agents/scripts/sync-claude-commands.js',
    summary:
      'Regenerate the .claude/commands/ projection of .agents/workflows/ (and .agents/local/workflows/), then the Codex skills under .agents/skills/workflows/.',
    flags: [],
  },
});
