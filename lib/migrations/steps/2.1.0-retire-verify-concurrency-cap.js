// lib/migrations/steps/2.1.0-retire-verify-concurrency-cap.js
/**
 * Story #4545 — retire `delivery.deliverRunner.verifyConcurrencyCap`.
 *
 * The knob was schema-validated, defaulted to 4, resolved by `getRunners`,
 * and documented as bounding "the per-wave verifyWaveResults loop" — a loop
 * that does not exist anywhere in the tree. Its only reader was
 * `analyze-execution.js`, which echoed the number into a perf report rather
 * than bounding anything; that CLI is deleted in the same Story. Setting the
 * knob to any value only ever changed a number printed in a report.
 *
 * `delivery.deliverRunner` declares `additionalProperties: false`, so a
 * consumer whose config still carries the key hits a hard AJV validation
 * failure on upgrade — every script that resolves config, not just the one
 * that read it. This step strips it before that check runs.
 *
 * Unlike the 2.1.0 mi-drop step, this one also sweeps `.agentrc.local.json`:
 * the resolver deep-merges the local override over `.agentrc.json` and
 * validates the *merged* result, so a key left in the local file fails the
 * same way a key in the committed file does.
 */

import nodeFs from 'node:fs';
import path from 'node:path';

const AGENTRC_FILENAMES = ['.agentrc.json', '.agentrc.local.json'];

/**
 * @param {unknown} ctx
 * @param {string} filename
 * @returns {string}
 */
function resolveAgentrcPath(ctx, filename) {
  const projectRoot = ctx?.projectRoot ?? process.cwd();
  return path.join(projectRoot, filename);
}

/**
 * @param {unknown} ctx
 * @param {string} filename
 * @param {typeof nodeFs} fsImpl
 * @returns {object | null}
 */
function readAgentrcConfig(ctx, filename, fsImpl) {
  try {
    const raw = fsImpl.readFileSync(resolveAgentrcPath(ctx, filename), 'utf8');
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
  const deliverRunner = config?.delivery?.deliverRunner;
  return (
    Boolean(deliverRunner) &&
    Object.hasOwn(deliverRunner, 'verifyConcurrencyCap')
  );
}

export const retireVerifyConcurrencyCap = {
  version: '2.1.0',
  description:
    'strip retired delivery.deliverRunner.verifyConcurrencyCap from ' +
    '.agentrc.json and .agentrc.local.json',
  /**
   * @param {{ projectRoot?: string, fs?: typeof nodeFs }} [ctx]
   * @returns {boolean}
   */
  detect(ctx) {
    const fsImpl = ctx?.fs ?? nodeFs;
    return AGENTRC_FILENAMES.some((filename) =>
      hasRetiredKey(readAgentrcConfig(ctx, filename, fsImpl)),
    );
  },
  /**
   * @param {{ projectRoot?: string, fs?: typeof nodeFs }} [ctx]
   * @returns {void}
   */
  apply(ctx) {
    const fsImpl = ctx?.fs ?? nodeFs;
    for (const filename of AGENTRC_FILENAMES) {
      const config = readAgentrcConfig(ctx, filename, fsImpl);
      if (!hasRetiredKey(config)) continue;

      delete config.delivery.deliverRunner.verifyConcurrencyCap;
      if (Object.keys(config.delivery.deliverRunner).length === 0) {
        delete config.delivery.deliverRunner;
      }

      fsImpl.writeFileSync(
        resolveAgentrcPath(ctx, filename),
        `${JSON.stringify(config, null, 2)}\n`,
      );
    }
  },
};
