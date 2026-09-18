#!/usr/bin/env node

/**
 * CLI: `.agentrc` leaf-key ceiling (Story #5382).
 *
 * Counts the leaf keys of the runtime `AGENTRC_SCHEMA` and fails when the
 * count rises above the landed ceiling, so a new key must displace an old one
 * or raise the ceiling deliberately. The rule lives in
 * `lib/agentrc-key-ceiling.js`; this file is the argv shell. Contributor-only,
 * so it lives in `scripts/` and never ships. Runs inside `npm run lint` via
 * `run-lint.js`.
 */

import { runAsCli } from '../.agents/scripts/lib/cli-utils.js';
import { AGENTRC_SCHEMA } from '../.agents/scripts/lib/config-settings-schema.js';
import { checkLeafKeyCeiling } from './lib/agentrc-key-ceiling.js';

const HELP = {
  invocation: 'node scripts/check-agentrc-key-ceiling.js',
  summary:
    'Fail when the .agentrc schema carries more leaf keys than the landed ceiling, so the config surface cannot regrow silently.',
  flags: [],
  notes: [
    'Exit codes:\n  0  at or under the ceiling\n  1  over the ceiling; the count and the ceiling are printed',
  ],
};

runAsCli(
  import.meta.url,
  async () => {
    const { count, ceiling, ok } = checkLeafKeyCeiling(AGENTRC_SCHEMA);
    if (ok) {
      process.stdout.write(
        `[agentrc-key-ceiling] ${count} leaf key(s), ceiling ${ceiling} — ok\n`,
      );
      return;
    }
    process.stderr.write(
      `[agentrc-key-ceiling] ${count} leaf key(s) exceeds the ceiling of ${ceiling}. ` +
        'Remove a key the new one displaces, or raise AGENTRC_LEAF_KEY_CEILING in scripts/lib/agentrc-key-ceiling.js and record why in docs/decisions.md.\n',
    );
    process.exitCode = 1;
  },
  { source: 'agentrc-key-ceiling', usage: HELP },
);
