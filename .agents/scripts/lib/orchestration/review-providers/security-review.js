/**
 * review-providers/security-review.js — runs `/security-review` through
 * `claude --print`. A missing CLI throws at construction; unparseable output
 * becomes one advisory finding rather than being dropped.
 *
 * @typedef {import('./types.js').Finding}        Finding
 * @typedef {import('./types.js').ReviewInput}    ReviewInput
 * @typedef {import('./types.js').ReviewProvider} ReviewProvider
 * @typedef {import('./types.js').Severity}       Severity
 */

import { spawnSync } from 'node:child_process';
import { parseProviderFindings } from './parse-findings.js';
import { renderDepthDirective } from './review-depth.js';

export const SECURITY_REVIEW_REMEDIATIONS = Object.freeze({
  install:
    'Install the Claude Code CLI (https://docs.anthropic.com/en/docs/claude-code) ' +
    'so the host registers the `/security-review` built-in skill.',
  fallback:
    'Or mark this provider entry as `optional: true` in .agentrc.json so ' +
    'the chain skips it on hosts without the skill.',
});

/**
 * Synchronous so a missing CLI surfaces at construction, not mid-review.
 * Shared by every `claude --print` provider.
 *
 * @param {{ spawnFn?: typeof spawnSync }} [opts]
 * @returns {boolean}
 */
export function probeClaudeCli(opts = {}) {
  const spawnFn = opts.spawnFn ?? spawnSync;
  try {
    const result = spawnFn('claude', ['--version'], {
      encoding: 'utf-8',
      shell: process.platform === 'win32',
      timeout: 5000,
    });
    return (result?.status ?? 1) === 0;
  } catch {
    return false;
  }
}

/**
 * @returns {Error}
 */
export function buildSecurityReviewUnavailableError() {
  return new Error(
    '[ReviewProviderFactory] codeReview provider "security-review" requires ' +
      'the `claude` CLI on PATH but it was not detected. ' +
      `${SECURITY_REVIEW_REMEDIATIONS.install} ${SECURITY_REVIEW_REMEDIATIONS.fallback}`,
  );
}

/**
 * Mirrors `CODEX_SEVERITY_MAP` for a consistent vocabulary across adapters.
 *
 * @type {Readonly<Record<string, Severity>>}
 */
export const SECURITY_REVIEW_SEVERITY_MAP = Object.freeze({
  blocker: 'critical',
  critical: 'critical',
  fatal: 'critical',
  major: 'high',
  high: 'high',
  error: 'high',
  minor: 'medium',
  medium: 'medium',
  warning: 'medium',
  info: 'suggestion',
  nit: 'suggestion',
  style: 'suggestion',
  suggestion: 'suggestion',
  note: 'suggestion',
});

/**
 * @param {unknown} raw
 * @returns {Severity}
 */
export function mapSecurityReviewSeverity(raw) {
  if (typeof raw !== 'string') return 'suggestion';
  const key = raw.trim().toLowerCase();
  return SECURITY_REVIEW_SEVERITY_MAP[key] ?? 'suggestion';
}

/**
 * @param {string} rawStdout
 * @returns {Finding[]}
 * @throws {Error} when stdout is not parseable JSON.
 */
export function parseSecurityReviewFindings(rawStdout) {
  return parseProviderFindings(rawStdout, {
    errorPrefix:
      '[security-review] Failed to parse /security-review stdout as JSON',
    mapSeverity: mapSecurityReviewSeverity,
    defaultCategory: 'security',
  });
}

/** Wraps `/security-review` with an explicit JSON-emit instruction. */
const SECURITY_REVIEW_INVOKE_PROMPT =
  'Run /security-review against the diff `{baseRef}`...`{headRef}` ' +
  'for {scopeLabel} #{ticketId}. {depthDirective} After the review, emit ' +
  'ONLY a JSON array of findings on stdout with this exact shape:\n\n' +
  '```\n[{"severity":"critical|high|medium|suggestion","title":"...",' +
  '"body":"...","file":"...","line":1,"category":"security"}]\n```\n\n' +
  'Use severity "critical" for blockers (must fix before merge), ' +
  '"high" for material risks, "medium" for issues worth fixing, and ' +
  '"suggestion" for advisory notes. Emit `[]` if you find nothing. ' +
  'No prose around the JSON.';

/**
 * @param {ReviewInput} input
 * @returns {string}
 */
export function buildSecurityReviewPrompt(input) {
  const scopeLabel = 'Story';
  const baseRef = typeof input?.baseRef === 'string' ? input.baseRef : '?';
  const headRef = typeof input?.headRef === 'string' ? input.headRef : '?';
  const ticketId =
    Number.isInteger(input?.ticketId) && input.ticketId > 0
      ? String(input.ticketId)
      : '?';
  return SECURITY_REVIEW_INVOKE_PROMPT.replace('{baseRef}', baseRef)
    .replace('{headRef}', headRef)
    .replace('{scopeLabel}', scopeLabel)
    .replace('{ticketId}', ticketId)
    .replace('{depthDirective}', renderDepthDirective(input?.depth));
}

/**
 * @param {ReviewInput} input
 * @returns {{ status: number, stdout: string, stderr: string }}
 */
function defaultInvokeSecurityReview(input) {
  const prompt = buildSecurityReviewPrompt(input);
  const result = spawnSync('claude', ['--print', prompt], {
    encoding: 'utf-8',
    shell: process.platform === 'win32',
    timeout: 10 * 60 * 1000,
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

/**
 * @returns {Finding}
 */
export function buildUnparseableFallbackFinding() {
  return {
    severity: 'suggestion',
    title: 'Security review output not parseable as JSON',
    body:
      'The `/security-review` skill returned text that did not parse as a ' +
      'JSON findings array. The review still ran — operators should inspect ' +
      'the skill output manually before merging. Treat as advisory; the ' +
      'chain did not halt.',
    category: 'security',
  };
}

/**
 * @param {{
 *   probeFn?: () => boolean,
 *   invokeFn?: (input: ReviewInput) => { status: number, stdout: string, stderr: string },
 *   logger?: { info?: Function, warn?: Function, error?: Function },
 * }} [deps]
 * @returns {ReviewProvider}
 */
export function createSecurityReviewProvider(deps = {}) {
  const probeFn = deps.probeFn ?? probeClaudeCli;
  if (!probeFn()) {
    throw buildSecurityReviewUnavailableError();
  }
  const invokeFn = deps.invokeFn ?? defaultInvokeSecurityReview;
  const logger = deps.logger;

  return {
    /**
     * @param {ReviewInput} input
     * @returns {Promise<Finding[]>}
     */
    async runReview(input) {
      const { scope, ticketId, baseRef, headRef } = input ?? {};
      if (!baseRef || !headRef) {
        throw new TypeError(
          '[security-review] runReview requires baseRef and headRef.',
        );
      }
      if (!Number.isInteger(ticketId) || ticketId <= 0) {
        throw new TypeError(
          '[security-review] runReview requires a positive integer ticketId.',
        );
      }

      logger?.info?.(
        `[security-review] Invoking /security-review for ${scope} #${ticketId} (${baseRef}...${headRef})...`,
      );

      const result = invokeFn({ scope, ticketId, baseRef, headRef });
      if (result.status !== 0) {
        throw new Error(
          `[security-review] claude --print /security-review exited with ` +
            `status ${result.status}: ${
              result.stderr || result.stdout || '<no output>'
            }`,
        );
      }

      try {
        const findings = parseSecurityReviewFindings(result.stdout);
        logger?.info?.(
          `[security-review] Parsed ${findings.length} finding(s) from /security-review.`,
        );
        return findings;
      } catch (err) {
        logger?.warn?.(
          `[security-review] Could not parse stdout as JSON; emitting advisory fallback: ${
            err?.message ?? err
          }`,
        );
        return [buildUnparseableFallbackFinding()];
      }
    },
  };
}

/**
 * @returns {ReviewProvider}
 */
export function createSecurityReviewProviderForRegistry() {
  return createSecurityReviewProvider();
}
