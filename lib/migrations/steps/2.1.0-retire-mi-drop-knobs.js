// lib/migrations/steps/2.1.0-retire-mi-drop-knobs.js
/**
 * Story #4531 — the first real step in the migration registry.
 *
 * `delivery.quality.codingGuardrails.miDropMustRefactor` and
 * `delivery.quality.autoRefresh.miDropCap` were schema-validated, defaulted,
 * and seeded by `apply-quality-bootstrap.js` into a consumer's
 * `.agentrc.json` — but never consumed by the gate they were named for
 * (`maintainability.tolerance` is the knob actually in force; see the
 * Story body for the full diagnosis). Both retired keys lived under
 * sub-schemas with `additionalProperties: false`, so a consumer whose
 * config still carries either key hits a hard AJV validation failure on
 * upgrade, not a warning. This step strips them before that check runs.
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
  const guardrails = config?.delivery?.quality?.codingGuardrails;
  const autoRefresh = config?.delivery?.quality?.autoRefresh;
  return (
    (Boolean(guardrails) && Object.hasOwn(guardrails, 'miDropMustRefactor')) ||
    (Boolean(autoRefresh) && Object.hasOwn(autoRefresh, 'miDropCap'))
  );
}

export const retireMiDropKnobs = {
  version: '2.1.0',
  description:
    'strip retired delivery.quality.codingGuardrails.miDropMustRefactor ' +
    'and delivery.quality.autoRefresh.miDropCap from .agentrc.json',
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

    const guardrails = config.delivery?.quality?.codingGuardrails;
    if (guardrails && Object.hasOwn(guardrails, 'miDropMustRefactor')) {
      delete guardrails.miDropMustRefactor;
      if (Object.keys(guardrails).length === 0) {
        delete config.delivery.quality.codingGuardrails;
      }
    }

    const autoRefresh = config.delivery?.quality?.autoRefresh;
    if (autoRefresh && Object.hasOwn(autoRefresh, 'miDropCap')) {
      delete autoRefresh.miDropCap;
      if (Object.keys(autoRefresh).length === 0) {
        delete config.delivery.quality.autoRefresh;
      }
    }

    fsImpl.writeFileSync(
      resolveAgentrcPath(ctx),
      `${JSON.stringify(config, null, 2)}\n`,
    );
  },
};
