// lib/cli/sync-agents.js
/** `mandrel sync-agents`: project `.agents/agents/` into `.claude/agents/`. */

import { createGuardedSync } from './guarded-sync.js';

export default createGuardedSync({
  command: 'sync-agents',
  target: '.claude/agents/',
  script: 'sync-claude-agents.js',
});
