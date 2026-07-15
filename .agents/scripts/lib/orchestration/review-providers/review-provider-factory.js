/**
 * review-providers/review-provider-factory.js — resolve
 * `codeReview.providers` to a concrete `ReviewProvider` instance.
 *
 * Story #2825 (Epic #2815) — the factory is the only entry point.
 * `runCodeReview()` never references a specific adapter directly;
 * adding a backend is (1) implement the interface, (2) register here,
 * (3) extend the schema enum.
 *
 * Story #2871 — the factory always returns a `ChainProvider` that
 * fans out `runReview` across every inline entry (merging `Finding[]`
 * in declaration order) and exposes `getPromptMessages` so the
 * orchestrator can render the trailing "Manual review suggestions"
 * section without knowing about per-provider mechanics.
 *
 * Behaviour:
 *   - Unset / empty `codeReview.providers` defaults to a single-entry
 *     chain `[{ name: 'native' }]`.
 *   - Unknown provider name throws an Error with remediation text
 *     naming the supported values.
 *   - Adapters that throw at construction time (e.g. `codex` probing
 *     for an absent plugin command) bubble their error verbatim —
 *     EXCEPT when the chain entry carries `optional: true`, in which
 *     case the chain logs a warning and skips that entry.
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
import { createNativeProviderForRegistry } from './native.js';
import { createSecurityReviewProviderForRegistry } from './security-review.js';
import { createUltrareviewProviderForRegistry } from './ultrareview.js';

/**
 * Inline provider registry — entries return a `ReviewProvider` that
 * produces `Finding[]` from a git diff.
 *
 * @type {Readonly<Record<string, () => ReviewProvider>>}
 */
const INLINE_PROVIDERS = Object.freeze({
  codex: createCodexProviderForRegistry,
  native: createNativeProviderForRegistry,
  'security-review': createSecurityReviewProviderForRegistry,
});

/**
 * Manual-prompt provider registry — entries return a
 * `ManualPromptProvider` that contributes a non-blocking operator
 * suggestion to the structured comment without running a review.
 *
 * @type {Readonly<Record<string, () => ManualPromptProvider>>}
 */
const PROMPT_PROVIDERS = Object.freeze({
  ultrareview: createUltrareviewProviderForRegistry,
});

/**
 * The inline provider name used when `codeReview.providers` is unset,
 * empty, or the `codeReview` block is absent entirely.
 */
export const DEFAULT_PROVIDER_NAME = 'native';

/**
 * Pure: build a gate predicate from a chain entry's `when` clause.
 * Currently supports `label` (single string) and `labelAny`
 * (string[]); other keys are rejected at the schema layer.
 *
 * `when` absent → gate is "always true".
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
 * Pure: scope filter — true when the entry's declared scope list
 * includes the current invocation scope. Default (no `scopes`) is
 * "fires on both" so unattended chains keep working at story-close
 * and epic-finalize alike.
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
 * Resolve a `ReviewProvider` instance from the resolved agentrc
 * config block. Pass the `codeReview` sub-object (not the full
 * config) so callers can compose with their own config readers.
 *
 * Always returns a `ChainProvider`. When `codeReviewConfig.providers`
 * is unset or empty, the chain defaults to `[{ name: 'native' }]`.
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
 * Build the inline + prompt entry list from a `providers: []` config.
 * Pure with respect to registry inputs — the registry is the only
 * side-effectful surface (provider constructors may probe disk or
 * spawn binaries).
 *
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
 * Wrap a resolved chain in a single `ReviewProvider`-compatible
 * object that the orchestrator can call uniformly. Inline adapters
 * fan out via `runReview`; prompt adapters fan out via
 * `getPromptMessages` (a method the orchestrator feature-detects).
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
 * Expose the registered provider names — primarily for diagnostics
 * and test fixtures. Lists both inline and prompt providers.
 *
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
 * Expose the inline-only provider names — used by adapter tests that
 * need to assert against the inline registry without coupling to
 * manual-prompt entries.
 *
 * @returns {string[]}
 */
export function listInlineProviders() {
  return Object.keys(INLINE_PROVIDERS).sort();
}

/**
 * Expose the manual-prompt-only provider names.
 *
 * @returns {string[]}
 */
export function listPromptProviders() {
  return Object.keys(PROMPT_PROVIDERS).sort();
}
