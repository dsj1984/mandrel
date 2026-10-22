// lib/migrations/steps/2.91.0-retire-duplication-formats.js
/**
 * Retire `delivery.quality.gates.duplication.formats` (the scorable formats
 * now derive from the scorable-extension list). Entries outside that list move
 * into `additionalFormats` so the upgrade keeps measuring them; an emptied
 * `duplication` block is pruned.
 */

import nodeFs from 'node:fs';
import {
  AGENTRC_FILENAMES,
  createRetireAgentrcKeyStep,
  readAgentrcConfig,
  resolveAgentrcPath,
} from '../helpers/retire-agentrc-key.js';

/** A 2.91.0 snapshot, not an import: migrations run builtins-only. */
const SCORABLE_FORMATS = Object.freeze([
  'javascript',
  'jsx',
  'typescript',
  'tsx',
]);

const retireFormats = createRetireAgentrcKeyStep({
  version: '2.91.0',
  description:
    'move non-scorable delivery.quality.gates.duplication.formats entries ' +
    'into additionalFormats, then strip the retired key from .agentrc.json ' +
    'and .agentrc.local.json (the scorable jscpd formats now derive from ' +
    'the scorable-extension list — Stories #5738, #5849)',
  keys: [
    {
      path: ['delivery', 'quality', 'gates', 'duplication', 'formats'],
      pruneDepth: 1,
    },
  ],
});

/**
 * @param {object | null} config
 * @returns {{ duplication: object, extra: string[] } | null}
 */
function nonScorableFormats(config) {
  const duplication = config?.delivery?.quality?.gates?.duplication;
  if (!Array.isArray(duplication?.formats)) return null;
  const extra = duplication.formats.filter(
    (name) => typeof name === 'string' && !SCORABLE_FORMATS.includes(name),
  );
  return extra.length > 0 ? { duplication, extra } : null;
}

/** Leaves `formats` itself for the retire step to strip. */
function carryNonScorableFormats(ctx) {
  const fsImpl = ctx?.fs ?? nodeFs;
  for (const filename of AGENTRC_FILENAMES) {
    const config = readAgentrcConfig(ctx, filename, fsImpl);
    const found = nonScorableFormats(config);
    if (!found) continue;
    const prior = Array.isArray(found.duplication.additionalFormats)
      ? found.duplication.additionalFormats
      : [];
    found.duplication.additionalFormats = [
      ...new Set([...prior, ...found.extra]),
    ];
    fsImpl.writeFileSync(
      resolveAgentrcPath(ctx, filename),
      `${JSON.stringify(config, null, 2)}\n`,
    );
  }
}

export const retireDuplicationFormats = {
  ...retireFormats,
  apply(ctx) {
    carryNonScorableFormats(ctx);
    retireFormats.apply(ctx);
  },
};
