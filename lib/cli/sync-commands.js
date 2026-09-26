// lib/cli/sync-commands.js
/** `mandrel sync-commands`: project `.agents/workflows/` into `.claude/commands/`. */

import { runGuardedSync } from './guarded-sync.js';

const SPEC = {
  command: 'sync-commands',
  target: '.claude/commands/',
  script: 'sync-claude-commands.js',
};

export default function run(argv, opts) {
  runGuardedSync(SPEC, argv, opts);
}
