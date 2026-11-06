// Shared doctor-check config read: .agentrc.json with the local overlay.

import path from 'node:path';
import { applyLocalOverlay } from '../../../.agents/scripts/lib/config/agentrc-overlay.js';
import { readJsonOrNull } from '../../../.agents/scripts/lib/json-utils.js';

/**
 * `.agentrc.json` with `.agentrc.local.json` merged over it; an unparseable
 * overlay leaves the committed file in force (the config check reports it).
 *
 * @param {string} projectRoot
 * @param {{ readFileSync: Function, existsSync: Function }} fsImpl
 * @returns {object}
 */
export function readEffectiveAgentrc(projectRoot, fsImpl) {
  const committed =
    readJsonOrNull(path.join(projectRoot, '.agentrc.json'), fsImpl) ?? {};
  try {
    return applyLocalOverlay({ fsImpl, projectRoot, committed }).effective;
  } catch {
    return committed;
  }
}
