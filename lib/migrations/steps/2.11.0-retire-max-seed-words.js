// lib/migrations/steps/2.11.0-retire-max-seed-words.js
/**
 * Story #4722 follow-up — strip the retired
 * `planning.complexityGate.maxSeedWords` knob from a consumer's
 * `.agentrc.json`.
 *
 * #4722 (PR #4725) hard-cutover-removed word-count complexity routing:
 * the route derives from the authored Story's shape, never from seed word
 * count, and `maxSeedWords` was dropped from the runtime AJV schema and
 * the published mirror. The `complexityGate` block carries
 * `additionalProperties: false`, so a consumer whose config still sets
 * `maxSeedWords` hits a hard validation failure on upgrade, not a
 * warning. This step strips the key before that check runs — the same
 * contract-cutover pattern as `2.1.0-retire-mi-drop-knobs.js`.
 */

import nodeFs from 'node:fs';
import path from 'node:path';

const AGENTRC_FILENAME = '.agentrc.json';

/**
 * @param {unknown} ctx
 * @returns {string}
 */
function resolveAgentrcPath(ctx) {
  const projectRoot = ctx?.projectRoot ?? process.cwd();
  return path.join(projectRoot, AGENTRC_FILENAME);
}

/**
 * @param {unknown} ctx
 * @param {typeof nodeFs} fsImpl
 * @returns {object | null}
 */
function readAgentrcConfig(ctx, fsImpl) {
  try {
    const raw = fsImpl.readFileSync(resolveAgentrcPath(ctx), 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * @param {object | null} config
 * @returns {boolean}
 */
function hasRetiredKey(config) {
  const gate = config?.planning?.complexityGate;
  return Boolean(gate) && Object.hasOwn(gate, 'maxSeedWords');
}

export const retireMaxSeedWords = {
  version: '2.11.0',
  description:
    'strip retired planning.complexityGate.maxSeedWords from .agentrc.json ' +
    '(complexity routes on Story shape, never seed word count — Story #4722)',
  /**
   * @param {{ projectRoot?: string, fs?: typeof nodeFs }} [ctx]
   * @returns {boolean}
   */
  detect(ctx) {
    const fsImpl = ctx?.fs ?? nodeFs;
    return hasRetiredKey(readAgentrcConfig(ctx, fsImpl));
  },
  /**
   * @param {{ projectRoot?: string, fs?: typeof nodeFs }} [ctx]
   * @returns {void}
   */
  apply(ctx) {
    const fsImpl = ctx?.fs ?? nodeFs;
    const config = readAgentrcConfig(ctx, fsImpl);
    if (!config) return;

    const gate = config.planning?.complexityGate;
    if (gate && Object.hasOwn(gate, 'maxSeedWords')) {
      delete gate.maxSeedWords;
      if (Object.keys(gate).length === 0) {
        delete config.planning.complexityGate;
        if (Object.keys(config.planning).length === 0) {
          delete config.planning;
        }
      }
    }

    fsImpl.writeFileSync(
      resolveAgentrcPath(ctx),
      `${JSON.stringify(config, null, 2)}\n`,
    );
  },
};
