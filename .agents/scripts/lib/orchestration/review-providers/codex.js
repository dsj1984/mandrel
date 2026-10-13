/**
 * review-providers/codex.js — ReviewProvider over the Codex CLI (`codex
 * exec`, see `codex-cli.js`), so a Codex-only host needs no `claude` binary.
 * A missing CLI hard-fails at construction; never a silent fallback to
 * native.
 *
 * @typedef {import('./types.js').Finding} Finding
 * @typedef {import('./types.js').ReviewInput} ReviewInput
 * @typedef {import('./types.js').ReviewProvider} ReviewProvider
 * @typedef {import('./types.js').Severity} Severity
 */

import {
  CODEX_SEVERITY_MAP,
  defaultProbeCodexCommand,
  invokeCodexExec,
} from './codex-cli.js';
import { parseProviderFindings } from './parse-findings.js';

export { CODEX_SEVERITY_MAP, defaultProbeCodexCommand };

export const CODEX_REMEDIATIONS = Object.freeze({
  install:
    'Install the Codex CLI (`npm install -g @openai/codex`) and sign in ' +
    'with `codex login` so `codex --version` succeeds on PATH.',
  fallback:
    'Or set `codeReview.providers` to [{ name: "native" }] in .agentrc.json to use the ' +
    'in-process maintainability/lint provider instead.',
});

/**
 * @returns {Error}
 */
export function buildCodexUnavailableError() {
  return new Error(
    '[ReviewProviderFactory] codeReview.providers includes "codex" but the ' +
      'Codex CLI is not available on this host (`codex --version` failed). ' +
      `${CODEX_REMEDIATIONS.install} ${CODEX_REMEDIATIONS.fallback}`,
  );
}

/**
 * @param {unknown} raw
 * @returns {Severity}
 */
export function mapCodexSeverity(raw) {
  if (typeof raw !== 'string') return 'suggestion';
  const key = raw.trim().toLowerCase();
  return CODEX_SEVERITY_MAP[key] ?? 'suggestion';
}

/**
 * The shared parser omits the schema's `null` file/line.
 *
 * @param {string} rawOutput - The `codex exec` last-message contents.
 * @returns {Finding[]}
 * @throws {Error} when the output is not parseable JSON.
 */
export function parseCodexFindings(rawOutput) {
  return parseProviderFindings(rawOutput, {
    errorPrefix: '[codex-review] Failed to parse codex exec output as JSON',
    mapSeverity: mapCodexSeverity,
  });
}

/**
 * @param {{
 *   probeFn?: () => boolean,
 *   invokeFn?: (args: { baseRef: string, headRef: string, scope: string, ticketId: number, depth?: import('./types.js').ReviewDepth }) => { status: number, stdout: string, stderr: string } | Promise<{ status: number, stdout: string, stderr: string }>,
 *   logger?: { info?: Function, warn?: Function, error?: Function },
 * }} [deps]
 * @returns {ReviewProvider}
 */
export function createCodexProvider(deps = {}) {
  const probeFn = deps.probeFn ?? defaultProbeCodexCommand;
  if (!probeFn()) {
    throw buildCodexUnavailableError();
  }

  const invokeFn = deps.invokeFn ?? invokeCodexExec;
  const logger = deps.logger;

  return {
    /**
     * @param {ReviewInput} input
     * @returns {Promise<Finding[]>}
     */
    async runReview(input) {
      const { scope, ticketId, baseRef, headRef, depth } = input ?? {};
      if (!baseRef || !headRef) {
        throw new TypeError(
          '[codex-review] runReview requires baseRef and headRef.',
        );
      }
      if (!Number.isInteger(ticketId) || ticketId <= 0) {
        throw new TypeError(
          '[codex-review] runReview requires a positive integer ticketId.',
        );
      }

      logger?.info?.(
        `[codex-review] Invoking codex exec on ${baseRef}...${headRef} ` +
          `for ${scope} #${ticketId}...`,
      );

      const result = await invokeFn({
        baseRef,
        headRef,
        scope,
        ticketId,
        depth,
      });
      if (result.status !== 0) {
        throw new Error(
          `[codex-review] codex exec exited with status ${result.status}: ${
            result.stderr || result.stdout || '<no output>'
          }`,
        );
      }

      const findings = parseCodexFindings(result.stdout);
      logger?.info?.(
        `[codex-review] Parsed ${findings.length} finding(s) from codex exec.`,
      );
      return findings;
    },
  };
}

/**
 * @returns {ReviewProvider}
 */
export function createCodexProviderForRegistry() {
  return createCodexProvider();
}
