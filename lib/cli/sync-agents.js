// lib/cli/sync-agents.js
/** `mandrel sync-agents`: project `.agents/agents/` into `.claude/agents/`. */

import { runGuardedSync } from './guarded-sync.js';

const SPEC = {
  command: 'sync-agents',
  target: '.claude/agents/',
  script: 'sync-claude-agents.js',
};

export default function run(argv, opts) {
  runGuardedSync(SPEC, argv, opts);
}
