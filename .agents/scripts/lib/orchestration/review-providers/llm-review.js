/**
 * review-providers/llm-review.js — the default chain's host-portable LLM
 * review: the first available of `code-review` (`claude --print`) then
 * `codex` (`codex exec`), chosen once at construction. First-available, not
 * both-optional, so a host with both CLIs pays for one LLM review per Story.
 * Neither CLI throws, so an `optional: true` entry skips with one warning.
 *
 * @typedef {import('./types.js').ReviewProvider} ReviewProvider
 * @typedef {import('./degraded-gates.js').GateDegradation} GateDegradation
 */

import { REVIEW_PROVIDER_CLIS } from '../../config/review-provider-clis.js';
import { createCodeReviewProviderForRegistry } from './code-review.js';
import {
  CODEX_REMEDIATIONS,
  createCodexProvider,
  defaultProbeCodexCommand,
} from './codex.js';
import { probeClaudeCli } from './security-review.js';

/** The delegate each CLI serves: what it probes and what it runs. */
const DELEGATE_BY_CLI = Object.freeze({
  claude: { name: 'code-review', cli: 'claude', runs: 'claude --print' },
  codex: { name: 'codex', cli: 'codex', runs: 'codex exec' },
});

/**
 * @returns {Error}
 */
export function buildLlmReviewUnavailableError() {
  return new Error(
    '[ReviewProviderFactory] codeReview provider "llm-review" found neither ' +
      'the `claude` CLI nor the `codex` CLI on PATH. Install the Claude Code ' +
      'CLI so `claude --version` succeeds. Or: ' +
      `${CODEX_REMEDIATIONS.install} ${CODEX_REMEDIATIONS.fallback}`,
  );
}

/**
 * The first delegate whose CLI answers, or null.
 *
 * @param {{ probeClaudeFn?: () => boolean, probeCodexFn?: () => boolean }} [deps]
 * @returns {(typeof DELEGATE_BY_CLI)[keyof typeof DELEGATE_BY_CLI] | null}
 */
export function resolveLlmReviewDelegate(deps = {}) {
  const probes = {
    claude: deps.probeClaudeFn ?? probeClaudeCli,
    codex: deps.probeCodexFn ?? defaultProbeCodexCommand,
  };
  const cli = REVIEW_PROVIDER_CLIS['llm-review'].find((c) => probes[c]());
  return DELEGATE_BY_CLI[cli] ?? null;
}

/**
 * @param {{
 *   probeClaudeFn?: () => boolean,
 *   probeCodexFn?: () => boolean,
 *   createCodeReviewFn?: (deps: object) => ReviewProvider,
 *   createCodexFn?: (deps: object) => ReviewProvider,
 *   logger?: { info?: Function, warn?: Function },
 * }} [deps] - the `create*Fn` seams build the chosen delegate; it is handed
 *   a pre-passed probe so the CLI is not probed twice.
 * @returns {ReviewProvider & { delegate: string, getDegradations: () => GateDegradation[] }}
 */
export function createLlmReviewProvider(deps = {}) {
  const chosen = resolveLlmReviewDelegate(deps);
  if (!chosen) throw buildLlmReviewUnavailableError();
  const build =
    chosen.name === 'code-review'
      ? (deps.createCodeReviewFn ?? createCodeReviewProviderForRegistry)
      : (deps.createCodexFn ?? createCodexProvider);
  const delegate = build({ probeFn: () => true, logger: deps.logger });
  const logger = deps.logger;

  return {
    delegate: chosen.name,
    async runReview(input) {
      logger?.info?.(
        `[llm-review] Reviewing through ${chosen.name} (${chosen.runs}).`,
      );
      return delegate.runReview(input);
    },
    getDegradations() {
      return typeof delegate.getDegradations === 'function'
        ? delegate.getDegradations()
        : [];
    },
  };
}

/**
 * @returns {ReviewProvider}
 */
export function createLlmReviewProviderForRegistry() {
  return createLlmReviewProvider();
}
