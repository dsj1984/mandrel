// lib/cli/sync-agents.js
/**
 * `mandrel sync-agents`: project `.agents/agents/` into `.claude/agents/` and,
 * in the same run, into Codex custom agents `.codex/agents/mandrel-<role>.toml`.
 */

import { runGuardedSync } from './guarded-sync.js';

const SPEC = {
  command: 'sync-agents',
  target: '.claude/agents/ and .codex/agents/',
  script: 'sync-claude-agents.js',
};

export default function run(argv, opts) {
  runGuardedSync(SPEC, argv, opts);
}
