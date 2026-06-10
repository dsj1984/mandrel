/**
 * review-providers/ultrareview.js — Manual-prompt provider for
 * Anthropic's `/ultrareview` cloud multi-agent review.
 *
 * Story #2871 — `/ultrareview` is user-triggered and billed by
 * Anthropic; it cannot be invoked programmatically from a Node
 * orchestrator. This adapter implements the `ManualPromptProvider`
 * shape instead of `ReviewProvider`: it emits a single Markdown
 * suggestion line into the structured `code-review` comment so the
 * operator sees the nudge inline with the rest of the review.
 *
 * The adapter is intentionally pure and host-agnostic. It does NOT
 * probe the host for Claude CLI availability — `renderPrompt()` only
 * produces text, and the worst case under a non-Claude host is a
 * suggestion the operator cannot act on. Documenting that suggestion
 * is still useful (consumer projects pin to a framework version, and
 * upgrading to a Claude-capable runtime exposes the value).
 *
 * Per the story acceptance contract: manual-prompt providers MUST
 * NEVER throw under any host.
 *
 * @typedef {import('./types.js').ManualPromptProvider} ManualPromptProvider
 * @typedef {import('./types.js').ManualPromptResult}   ManualPromptResult
 * @typedef {import('./types.js').ReviewInput}          ReviewInput
 */

import { renderDepthDirective } from './review-depth.js';

/**
 * Canonical suggestion string. Exported so tests can assert against
 * the exact wording rather than free-text matching, and so doc
 * tooling can lift the line without spawning a fake review.
 *
 * The `{depthDirective}` slot renders the risk-derived thoroughness lever
 * (Story #3937) so the operator nudge tells the human reviewer how deep to go
 * when they trigger `/ultrareview` — a high-risk Epic asks for a deep
 * second-pass review, a low-risk one keeps it light.
 */
export const ULTRAREVIEW_PROMPT_TEMPLATE =
  '💡 **Suggested:** Consider running `/ultrareview` on this ' +
  '{scopeLabel} (`{baseRef}`…`{headRef}`) before merging — ' +
  "Anthropic's multi-agent cloud review surfaces issues that " +
  'single-pass review can miss. This is operator-triggered ' +
  '(billed by Anthropic); not a blocker. {depthDirective}';

/**
 * Render the canonical suggestion string with the live scope/baseRef/
 * headRef substituted, and the risk-derived `depth` lever (Story #3937)
 * rendered into the nudge via `renderDepthDirective` (absent depth → the
 * `standard` directive).
 *
 * Pure — exported for testing.
 *
 * @param {ReviewInput} input
 * @returns {string}
 */
export function buildUltrareviewMessage(input) {
  const scopeLabel = input?.scope === 'epic' ? 'Epic' : 'Story';
  const baseRef = typeof input?.baseRef === 'string' ? input.baseRef : '?';
  const headRef = typeof input?.headRef === 'string' ? input.headRef : '?';
  return ULTRAREVIEW_PROMPT_TEMPLATE.replace('{scopeLabel}', scopeLabel)
    .replace('{baseRef}', baseRef)
    .replace('{headRef}', headRef)
    .replace('{depthDirective}', renderDepthDirective(input?.depth));
}

/**
 * Build a `ManualPromptProvider` instance for the `ultrareview`
 * registry slot.
 *
 * The `deps` overload exists only for test parity with the inline
 * provider factories — production callers (the factory) invoke
 * `createUltrareviewProvider()` with no arguments.
 *
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
 * Zero-arg factory entry point used by the `review-provider-factory`
 * registry. Mirrors `createCodexProviderForRegistry` so the registry
 * signature stays `() => ManualPromptProvider`.
 *
 * @returns {ManualPromptProvider}
 */
export function createUltrareviewProviderForRegistry() {
  return createUltrareviewProvider();
}
