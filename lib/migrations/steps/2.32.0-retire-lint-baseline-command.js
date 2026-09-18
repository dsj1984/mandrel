// lib/migrations/steps/2.32.0-retire-lint-baseline-command.js
/**
 * Strip `project.commands.lintBaseline` (its capture CLI is gone). An emptied
 * `commands` is kept: `project` is required and `{}` is valid.
 */

import { createRetireAgentrcKeyStep } from '../helpers/retire-agentrc-key.js';

export const retireLintBaselineCommand = createRetireAgentrcKeyStep({
  version: '2.32.0',
  description:
    'strip retired project.commands.lintBaseline from .agentrc.json ' +
    '(the framework lint-baseline capture CLI is gone — Story #5004)',
  keys: [{ path: ['project', 'commands', 'lintBaseline'], pruneDepth: 0 }],
});
