// lib/migrations/steps/2.1.0-retire-mi-drop-knobs.js
/**
 * Strip the never-read MI-drop knobs. Base config only: the bootstrap script
 * wrote them, never an operator's local overlay.
 */

import {
  AGENTRC_BASE_FILENAME,
  createRetireAgentrcKeyStep,
} from '../helpers/retire-agentrc-key.js';

export const retireMiDropKnobs = createRetireAgentrcKeyStep({
  version: '2.1.0',
  description:
    'strip retired delivery.quality.codingGuardrails.miDropMustRefactor ' +
    'and delivery.quality.autoRefresh.miDropCap from .agentrc.json',
  filenames: [AGENTRC_BASE_FILENAME],
  keys: [
    {
      path: ['delivery', 'quality', 'codingGuardrails', 'miDropMustRefactor'],
      pruneDepth: 1,
    },
    {
      path: ['delivery', 'quality', 'autoRefresh', 'miDropCap'],
      pruneDepth: 1,
    },
  ],
});
