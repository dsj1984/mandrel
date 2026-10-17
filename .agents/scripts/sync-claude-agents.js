#!/usr/bin/env node

/** Project the role agents for Claude, then Codex, from `process.cwd()`. */

import {
  CLAUDE_AGENTS_DIR,
  syncClaudeAgents,
} from './lib/claude/agents-projection.js';
import { runAsCli } from './lib/cli-utils.js';
import {
  CODEX_AGENTS_DIR,
  syncCodexAgents,
} from './lib/codex/agents-projection.js';
import { getAgentModels } from './lib/config/agent-models.js';
import { resolveConfig } from './lib/config-resolver.js';
import { Logger } from './lib/Logger.js';

/** @returns {Promise<void>} */
async function main() {
  // cwd, never `__dirname/../..`, which lands inside node_modules.
  const projectRoot = process.cwd();
  const log = (line) => Logger.info(line);
  const claude = syncClaudeAgents({
    projectRoot,
    // Validated: an unknown role fails the sync.
    agentModels: getAgentModels(resolveConfig({ cwd: projectRoot })),
    log,
    warn: (line) => Logger.warn(line),
  });
  Logger.info(
    `\n✔ ${claude.written.length} file(s) synced, ${claude.total} total agents in ${CLAUDE_AGENTS_DIR}/`,
  );
  const codex = syncCodexAgents({ projectRoot, log });
  Logger.info(
    `✔ ${codex.written.length} file(s) synced, ${codex.total} total Codex agents in ${CODEX_AGENTS_DIR}/`,
  );
}

runAsCli(import.meta.url, main, {
  source: 'sync-claude-agents',
  usage: {
    invocation: 'node .agents/scripts/sync-claude-agents.js',
    summary:
      'Regenerate the .claude/agents/ projection of .agents/agents/ (and .agents/local/agents/), then the Codex agents under .codex/agents/.',
    flags: [],
  },
});
