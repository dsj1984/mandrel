// lib/cli/sync-commands.js
/**
 * `mandrel sync-commands`: project `.agents/workflows/` into `.claude/commands/`
 * and, in the same run, into Codex skills under `.agents/skills/workflows/`.
 */

import { runGuardedSync } from './guarded-sync.js';

const SPEC = {
  command: 'sync-commands',
  target: '.claude/commands/ and .agents/skills/workflows/',
  script: 'sync-claude-commands.js',
};

export default function run(argv, opts) {
  runGuardedSync(SPEC, argv, opts);
}
