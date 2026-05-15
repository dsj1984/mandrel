#!/usr/bin/env node
/* node:coverage ignore file */

import { parseArgs } from 'node:util';
import { runHydrateContext } from './hydrate-context.js';
import { runAsCli } from './lib/cli-utils.js';
import { resolveConfig } from './lib/config-resolver.js';
import { Logger } from './lib/Logger.js';
import { createProvider } from './lib/provider-factory.js';

export { runHydrateContext, ticketToTask } from './hydrate-context.js';
export {
  hydrateContext,
  parseHierarchy,
  truncateToTokenBudget,
} from './lib/orchestration/context-hydration-engine.js';

async function main() {
  const { values } = parseArgs({
    options: {
      task: { type: 'string' },
      ticket: { type: 'string' },
      epic: { type: 'string' },
    },
    strict: false,
  });

  const ticketId = Number.parseInt(values.ticket ?? values.task ?? '', 10);
  const epicId = Number.parseInt(values.epic ?? '', 10);

  if (!ticketId || !epicId) {
    throw new Error('Missing required arguments: (--task|--ticket) and --epic');
  }

  const { orchestration } = resolveConfig();
  const provider = createProvider(orchestration);

  Logger.error(
    `[Hydrator] Hydrating context for Ticket #${ticketId} (Epic #${epicId})...`,
  );

  const { prompt } = await runHydrateContext({ ticketId, epicId, provider });
  process.stdout.write(prompt);
}

runAsCli(import.meta.url, main, { source: 'ContextHydrator' });
