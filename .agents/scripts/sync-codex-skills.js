#!/usr/bin/env node

/**
 * Project the workflow set into Codex skills under `.agents/skills/workflows/`.
 * `sync-claude-commands.js` runs the same projection after the Claude one, so
 * `mandrel sync-commands` and `npm run sync:commands` cover both hosts; this
 * entry point refreshes the Codex half alone.
 */

import { runAsCli } from './lib/cli-utils.js';
import {
  CODEX_SKILLS_DIR,
  syncCodexSkills,
} from './lib/codex/skills-projection.js';
import { Logger } from './lib/Logger.js';

/** @returns {Promise<void>} */
async function main() {
  const { written, total } = syncCodexSkills({
    projectRoot: process.cwd(),
    log: (line) => Logger.info(line),
  });
  Logger.info(
    `\n✔ ${written.length} file(s) synced, ${total} total skills in ${CODEX_SKILLS_DIR}/`,
  );
}

runAsCli(import.meta.url, main, {
  source: 'sync-codex-skills',
  usage: {
    invocation: 'node .agents/scripts/sync-codex-skills.js',
    summary:
      'Regenerate the Codex skill projection of .agents/workflows/ (and .agents/local/workflows/) under .agents/skills/workflows/.',
    flags: [],
  },
});
