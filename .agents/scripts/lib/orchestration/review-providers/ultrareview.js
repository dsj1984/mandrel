/**
 * review-providers/ultrareview.js — manual-prompt provider nudging the
 * operator to run `/ultrareview`, which is user-triggered and cannot be
 * invoked programmatically. Pure and host-agnostic (no CLI probe); it MUST
 * NEVER throw under any host.
 *
 * @typedef {import('./types.js').ManualPromptProvider} ManualPromptProvider
 * @typedef {import('./types.js').ManualPromptResult}   ManualPromptResult
 * @typedef {import('./types.js').ReviewInput}          ReviewInput
 */

import { renderDepthDirective } from './review-depth.js';

export const ULTRAREVIEW_PROMPT_TEMPLATE =
  '💡 **Suggested:** Consider running `/ultrareview` on this ' +
  '{scopeLabel} (`{baseRef}`…`{headRef}`) before merging — ' +
  "Anthropic's multi-agent cloud review surfaces issues that " +
  'single-pass review can miss. This is operator-triggered ' +
  '(billed by Anthropic); not a blocker. {depthDirective}';

/**
 * @param {ReviewInput} input
 * @returns {string}
 */
export function buildUltrareviewMessage(input) {
  const scopeLabel = 'Story';
  const baseRef = typeof input?.baseRef === 'string' ? input.baseRef : '?';
  const headRef = typeof input?.headRef === 'string' ? input.headRef : '?';
  return ULTRAREVIEW_PROMPT_TEMPLATE.replace('{scopeLabel}', scopeLabel)
    .replace('{baseRef}', baseRef)
    .replace('{headRef}', headRef)
    .replace('{depthDirective}', renderDepthDirective(input?.depth));
}

/**
 * @param {{
 *   logger?: { info?: Function, warn?: Function },
 * }} [deps]
 * @returns {ManualPromptProvider}
 */
export function createUltrareviewProvider(deps = {}) {
  const logger = deps.logger;

  return {
    /**
     * @param {ReviewInput} input
     * @returns {Promise<ManualPromptResult>}
     */
    async renderPrompt(input) {
      const message = buildUltrareviewMessage(input);
      logger?.info?.(
        '[ultrareview] Manual-prompt suggestion rendered (non-blocking).',
      );
      return { message };
    },
  };
}

/**
 * @returns {ManualPromptProvider}
 */
export function createUltrareviewProviderForRegistry() {
  return createUltrareviewProvider();
}
