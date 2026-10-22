// lib/migrations/steps/2.97.0-retire-quality-navigability.js
/**
 * Retire the `delivery.quality.navigability` block. The route
 * tree and nav registry have one home, `planning.navigation`, which the plan
 * reachability gate, the navigability lens and the audit selector all read;
 * `journeySuite` and this block's `navRegistry` had no reader. Values are not
 * moved — that would switch on the plan-time reachability gate — so a value
 * `planning.navigation` does not already carry is reported as a behaviour
 * change instead.
 */

import nodeFs from 'node:fs';
import {
  AGENTRC_FILENAMES,
  createRetireAgentrcKeyStep,
  readAgentrcConfig,
} from '../helpers/retire-agentrc-key.js';

const BLOCK = ['delivery', 'quality', 'navigability'];

/** The planning.navigation sibling that now owns each key; null = no reader. */
const SUCCESSORS = Object.freeze({
  routeGlobs: 'routeGlobs',
  navRegistry: 'navRegistry',
  journeySuite: null,
});

const retireBlock = createRetireAgentrcKeyStep({
  version: '2.97.0',
  description:
    'strip delivery.quality.navigability from .agentrc.json and ' +
    '.agentrc.local.json — route globs and the nav registry live under ' +
    'planning.navigation, and journeySuite had no reader (Story #5850)',
  keys: Object.keys(SUCCESSORS).map((key) => ({
    path: [...BLOCK, key],
    pruneDepth: 1,
  })),
});

/**
 * @param {string} filename
 * @param {object} config
 * @returns {string[]}
 */
function reportLines(filename, config) {
  const block = config?.delivery?.quality?.navigability;
  if (!block || typeof block !== 'object') return [];
  const planning = config?.planning?.navigation ?? {};
  const lines = [];
  for (const [key, successor] of Object.entries(SUCCESSORS)) {
    if (!Object.hasOwn(block, key)) continue;
    const dotted = `${BLOCK.join('.')}.${key}`;
    const value = JSON.stringify(block[key]);
    if (successor === null) {
      lines.push(`  removed ${filename} ${dotted}; it had no reader`);
    } else if (JSON.stringify(planning[successor]) === value) {
      lines.push(
        `  removed ${filename} ${dotted}; planning.navigation.${successor} already carries it`,
      );
    } else {
      lines.push(
        `  behaviour change: ${filename} set ${dotted} = ${value}; set planning.navigation.${successor} to keep it`,
      );
    }
  }
  return lines;
}

export const retireQualityNavigability = {
  ...retireBlock,
  apply(ctx) {
    const fsImpl = ctx?.fs ?? nodeFs;
    const log = ctx?.log ?? console.log;
    for (const filename of AGENTRC_FILENAMES) {
      const config = readAgentrcConfig(ctx, filename, fsImpl);
      for (const line of reportLines(filename, config)) log(line);
    }
    retireBlock.apply(ctx);
  },
};
