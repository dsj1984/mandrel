// lib/cli/sync-commands.js
/** `mandrel sync-commands`: project `.agents/workflows/` into `.claude/commands/`. */

import { createGuardedSync } from './guarded-sync.js';

export default createGuardedSync({
  command: 'sync-commands',
  target: '.claude/commands/',
  script: 'sync-claude-commands.js',
});
