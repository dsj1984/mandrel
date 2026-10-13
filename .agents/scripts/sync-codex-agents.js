#!/usr/bin/env node

/**
 * Project the role agents into Codex custom agents under `.codex/agents/`.
 * `sync-claude-agents.js` runs the same projection after the Claude one, so
 * `mandrel sync-agents` and `npm run sync:agents` cover both hosts; this
 * entry point refreshes the Codex half alone.
 */

import { runAsCli } from './lib/cli-utils.js';
import {
  CODEX_AGENTS_DIR,
  syncCodexAgents,
} from './lib/codex/agents-projection.js';
import { Logger } from './lib/Logger.js';

/** @returns {Promise<void>} */
async function main() {
  const { written, total } = syncCodexAgents({
    projectRoot: process.cwd(),
    log: (line) => Logger.info(line),
  });
  Logger.info(
    `\n✔ ${written.length} file(s) synced, ${total} total agents in ${CODEX_AGENTS_DIR}/`,
  );
}

runAsCli(import.meta.url, main, {
  source: 'sync-codex-agents',
  usage: {
    invocation: 'node .agents/scripts/sync-codex-agents.js',
    summary:
      'Regenerate the Codex custom-agent projection of .agents/agents/ (and .agents/local/agents/) as .codex/agents/mandrel-<role>.toml.',
    flags: [],
  },
});
