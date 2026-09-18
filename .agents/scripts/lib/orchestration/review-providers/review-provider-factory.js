/**
 * review-providers/review-provider-factory.js — resolves
 * `codeReview.providers` into a `ChainProvider`. A failing entry throws
 * unless it is `optional`.
 *
 * @typedef {import('./types.js').ReviewProvider}        ReviewProvider
 * @typedef {import('./types.js').ManualPromptProvider}  ManualPromptProvider
 * @typedef {import('./types.js').Finding}               Finding
 * @typedef {import('./types.js').ReviewInput}           ReviewInput
 * @typedef {import('./types.js').ProviderGate}          ProviderGate
 * @typedef {import('./types.js').ProviderGateContext}   ProviderGateContext
 * @typedef {import('./types.js').InlineChainEntry}      InlineChainEntry
 * @typedef {import('./types.js').PromptChainEntry}      PromptChainEntry
 * @typedef {import('./types.js').ProviderChain}         ProviderChain
 */

import { createCodexProviderForRegistry } from './codex.js';
import { mergeChainDegradations } from './degraded-gates.js';
import { createNativeProviderForRegistry } from './native.js';
import { createSecurityReviewProviderForRegistry } from './security-review.js';
import { createUltrareviewProviderForRegistry } from './ultrareview.js';

/** @type {Readonly<Record<string, () => ReviewProvider>>} */
const INLINE_PROVIDERS = Object.freeze({
  codex: createCodexProviderForRegistry,
  native: createNativeProviderForRegistry,
  'security-review': createSecurityReviewProviderForRegistry,
});

/**
 * Non-blocking operator suggestions; they run no review.
 *
 * @type {Readonly<Record<string, () => ManualPromptProvider>>}
 */
const PROMPT_PROVIDERS = Object.freeze({
  ultrareview: createUltrareviewProviderForRegistry,
});

export const DEFAULT_PROVIDER_NAME = 'native';

/**
 * Gate predicate from a `when` clause (`label` / `labelAny`); absent → always true.
 *
 * @param {{ label?: string, labelAny?: string[] }|undefined} when
 * @returns {ProviderGate}
 */
export function buildGate(when) {
  if (!when || typeof when !== 'object') return () => true;
  const singleLabel = typeof when.label === 'string' ? when.label : null;
  const anyLabels = Array.isArray(when.labelAny)
    ? when.labelAny.filter((l) => typeof l === 'string' && l.length > 0)
    : null;
  if (!singleLabel && (!anyLabels || anyLabels.length === 0)) {
    return () => true;
  }
  return (ctx) => {
    const labels = Array.isArray(ctx?.labels) ? ctx.labels : [];
    if (singleLabel && !labels.includes(singleLabel)) return false;
    if (anyLabels && anyLabels.length > 0) {
      const hit = anyLabels.some((l) => labels.includes(l));
      if (!hit) return false;
    }
    return true;
  };
}

/**
 * No declared `scopes` fires on every scope.
 *
 * @param {string[]|undefined} declaredScopes
 * @param {string} currentScope
 * @returns {boolean}
 */
export function isScopeApplicable(declaredScopes, currentScope) {
  if (!Array.isArray(declaredScopes) || declaredScopes.length === 0) {
    return true;
  }
  return declaredScopes.includes(currentScope);
}

/**
 * Takes the `codeReview` sub-object; unset/empty `providers` defaults to native.
 *
 * @param {{
 *   providers?: Array<object>,
 *   providerConfig?: object,
 * }|null|undefined} codeReviewConfig
 * @param {{
 *   inlineRegistry?: Readonly<Record<string, () => ReviewProvider>>,
 *   promptRegistry?: Readonly<Record<string, () => ManualPromptProvider>>,
 *   registry?: Readonly<Record<string, () => ReviewProvider>>,
 *   logger?: { info?: Function, warn?: Function },
 * }} [opts]
 * @returns {ReviewProvider}
 * @throws {Error} when the configured provider name is not registered.
 */
export function createReviewProvider(codeReviewConfig, opts = {}) {
  const inlineRegistry =
    opts.inlineRegistry ?? opts.registry ?? INLINE_PROVIDERS;
  const promptRegistry = opts.promptRegistry ?? PROMPT_PROVIDERS;
  const logger = opts.logger;

  const entries =
    codeReviewConfig &&
    Array.isArray(codeReviewConfig.providers) &&
    codeReviewConfig.providers.length > 0
      ? codeReviewConfig.providers
      : [{ name: DEFAULT_PROVIDER_NAME }];

  const chain = buildProviderChain(entries, {
    inlineRegistry,
    promptRegistry,
    logger,
  });
  return createChainProvider(chain, { logger });
}

/**
 * @param {Array<object>} entries
 * @param {{
 *   inlineRegistry: Readonly<Record<string, () => ReviewProvider>>,
 *   promptRegistry: Readonly<Record<string, () => ManualPromptProvider>>,
 *   logger?: { info?: Function, warn?: Function },
 * }} ctx
 * @returns {ProviderChain}
 */
export function buildProviderChain(entries, ctx) {
  const { inlineRegistry, promptRegistry, logger } = ctx;
  /** @type {InlineChainEntry[]} */
  const inline = [];
  /** @type {PromptChainEntry[]} */
  const prompts = [];

  for (const raw of entries) {
    if (!raw || typeof raw !== 'object' || typeof raw.name !== 'string') {
      throw new Error(
        '[ReviewProviderFactory] Chain entry missing required `name` string field.',
      );
    }
    const { name } = raw;
    const optional = raw.optional === true;
    const manualPrompt = raw.manualPrompt === true;
    const scopes = Array.isArray(raw.scopes) ? raw.scopes : undefined;
    const whenGate = buildGate(raw.when);
    /** @type {ProviderGate} */
    const gate = (gctx) => {
      if (!isScopeApplicable(scopes, gctx.scope)) return false;
      return whenGate(gctx);
    };

    const registry = manualPrompt ? promptRegistry : inlineRegistry;
    const ctor = registry[name];
    if (!ctor) {
      if (optional) {
        logger?.warn?.(
          `[ReviewProviderFactory] Unknown ${
            manualPrompt ? 'manual-prompt' : 'inline'
          } provider "${name}" in chain; skipping (optional=true).`,
        );
        continue;
      }
      const supported = Object.keys(registry).sort().join(', ');
      throw new Error(
        `[ReviewProviderFactory] Unknown ${
          manualPrompt ? 'manual-prompt' : 'inline'
        } provider "${name}" in codeReview.providers chain. ` +
          `Supported values for this slot: ${supported}.`,
      );
    }

    let constructed;
    try {
      constructed = ctor();
    } catch (err) {
      if (optional) {
        logger?.warn?.(
          `[code-review] ${name} unavailable on this host; skipping (optional=true). ${
            err?.message ?? err
          }`,
        );
        continue;
      }
      throw err;
    }

    if (manualPrompt) {
      prompts.push({ name, provider: constructed, gate });
    } else {
      inline.push({ name, provider: constructed, gate });
    }
  }

  return { inline, prompts };
}

/**
 * Inline findings merge in declaration order; prompt entries render via
 * `getPromptMessages`.
 *
 * @param {ProviderChain} chain
 * @param {{ logger?: { info?: Function, warn?: Function } }} [opts]
 * @returns {ReviewProvider & {
 *   getPromptMessages: (input: ReviewInput) => Promise<string[]>,
 *   chain: ProviderChain,
 * }}
 */
export function createChainProvider(chain, opts = {}) {
  const logger = opts.logger;

  return {
    chain,
    /**
     * @param {ReviewInput} input
     * @returns {Promise<Finding[]>}
     */
    async runReview(input) {
      /** @type {Finding[]} */
      const merged = [];
      const ctx = {
        scope: input?.scope,
        labels: /** @type {ReadonlyArray<string>} */ (
          /** @type {any} */ (input)?.labels ?? []
        ),
      };
      for (const entry of chain.inline) {
        if (!entry.gate(ctx)) {
          logger?.info?.(
            `[code-review] Skipping inline provider "${entry.name}" (gate=false).`,
          );
          continue;
        }
        const findings = await entry.provider.runReview(input);
        if (!Array.isArray(findings)) {
          throw new TypeError(
            `[code-review] Inline provider "${entry.name}" returned a non-array; expected Finding[].`,
          );
        }
        for (const f of findings) merged.push(f);
      }
      return merged;
    },
    /**
     * Called after `runReview`.
     *
     * @returns {Promise<Array<object>>}
     */
    async getDegradations() {
      return mergeChainDegradations(chain.inline, logger);
    },
    /**
     * @param {ReviewInput} input
     * @returns {Promise<string[]>}
     */
    async getPromptMessages(input) {
      const messages = [];
      const ctx = {
        scope: input?.scope,
        labels: /** @type {ReadonlyArray<string>} */ (
          /** @type {any} */ (input)?.labels ?? []
        ),
      };
      for (const entry of chain.prompts) {
        if (!entry.gate(ctx)) {
          logger?.info?.(
            `[code-review] Skipping manual-prompt provider "${entry.name}" (gate=false).`,
          );
          continue;
        }
        try {
          const result = await entry.provider.renderPrompt(input);
          if (result && typeof result.message === 'string') {
            messages.push(result.message);
          }
        } catch (err) {
          // Manual-prompt providers MUST NEVER block the chain.
          logger?.warn?.(
            `[code-review] Manual-prompt provider "${entry.name}" failed; skipping. ${
              err?.message ?? err
            }`,
          );
        }
      }
      return messages;
    },
  };
}

/**
 * @returns {string[]}
 */
export function listRegisteredProviders() {
  const all = new Set([
    ...Object.keys(INLINE_PROVIDERS),
    ...Object.keys(PROMPT_PROVIDERS),
  ]);
  return [...all].sort();
}

/**
 * @returns {string[]}
 */
export function listInlineProviders() {
  return Object.keys(INLINE_PROVIDERS).sort();
}

/**
 * @returns {string[]}
 */
export function listPromptProviders() {
  return Object.keys(PROMPT_PROVIDERS).sort();
}
