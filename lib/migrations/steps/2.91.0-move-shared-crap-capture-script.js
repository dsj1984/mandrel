// lib/migrations/steps/2.91.0-move-shared-crap-capture-script.js
/**
 * Move a `delivery.quality.gates.crap.captureScript` that has no own CRAP
 * artifact to `delivery.quality.gates.coverage.captureScript`. A shared
 * artifact has one writer — the coverage gate — so the resolver now refuses
 * the CRAP key without an own `crap.coveragePath`. An explicit coverage
 * `captureScript` wins; the CRAP key is dropped either way. Each config
 * surface is rewritten on its own. Builtins only.
 */

import nodeFs from 'node:fs';
import { COVERAGE_CAPTURE_DEFAULTS } from '../../../.agents/scripts/lib/config/gates/coverage.schema.js';
import {
  AGENTRC_FILENAMES,
  resolveAgentrcPath as agentrcPath,
  readAgentrcConfig as readConfig,
} from '../helpers/retire-agentrc-key.js';

/** @param {object|null} config */
function gatesOf(config) {
  const gates = config?.delivery?.quality?.gates;
  return gates && typeof gates === 'object' ? gates : null;
}

/** @param {unknown} value */
function slashed(value) {
  return typeof value === 'string' ? value.trim().replace(/\\/g, '/') : '';
}

/**
 * The CRAP gate's `captureScript` with no own artifact, or `null`.
 *
 * @param {object|null} config
 * @returns {string|null}
 */
function sharedCrapScript(config) {
  const gates = gatesOf(config);
  const script = gates?.crap?.captureScript;
  if (typeof script !== 'string') return null;
  const own = slashed(gates.crap.coveragePath);
  const shared =
    slashed(gates.coverage?.coveragePath) ||
    COVERAGE_CAPTURE_DEFAULTS.coveragePath;
  return own === '' || own === shared ? script : null;
}

/** @param {object} config @param {string} script */
function moveScript(config, script) {
  const gates = gatesOf(config);
  delete gates.crap.captureScript;
  gates.coverage = gates.coverage ?? {};
  if (gates.coverage.captureScript === undefined) {
    gates.coverage.captureScript = script;
  }
}

export const moveSharedCrapCaptureScript = {
  version: '2.91.0',
  description:
    'move a crap.captureScript with no own crap.coveragePath to ' +
    'coverage.captureScript — the coverage gate now owns its capture script ' +
    '(Story #5737)',
  /** @param {{ projectRoot?: string, fs?: typeof nodeFs }} [ctx] */
  detect(ctx) {
    const fsImpl = ctx?.fs ?? nodeFs;
    return AGENTRC_FILENAMES.some(
      (name) => sharedCrapScript(readConfig(ctx, name, fsImpl)) !== null,
    );
  },
  /** @param {{ projectRoot?: string, fs?: typeof nodeFs }} [ctx] */
  apply(ctx) {
    const fsImpl = ctx?.fs ?? nodeFs;
    for (const name of AGENTRC_FILENAMES) {
      const config = readConfig(ctx, name, fsImpl);
      const script = sharedCrapScript(config);
      if (script === null) continue;
      moveScript(config, script);
      fsImpl.writeFileSync(
        agentrcPath(ctx, name),
        `${JSON.stringify(config, null, 2)}\n`,
      );
    }
  },
};
