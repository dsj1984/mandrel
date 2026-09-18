// lib/migrations/steps/2.20.0-retire-codebase-snapshot.js
/** Strip the reader-less `planning.codebaseSnapshot` block. */

import { createRetireAgentrcKeyStep } from '../helpers/retire-agentrc-key.js';

export const retireCodebaseSnapshot = createRetireAgentrcKeyStep({
  version: '2.20.0',
  description:
    'strip retired planning.codebaseSnapshot from .agentrc.json / ' +
    '.agentrc.local.json (spec authoring is grounded by targeted retrieval ' +
    'plus the Phase 8 file-assumption gate — Story #4811)',
  keys: [{ path: ['planning', 'codebaseSnapshot'], pruneDepth: 1 }],
});
