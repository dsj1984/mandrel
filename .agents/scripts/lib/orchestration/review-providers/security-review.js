/**
 * review-providers/security-review.js — Inline ReviewProvider that
 * invokes Anthropic's built-in `/security-review` Claude Code skill.
 *
 * Story #2871 — extends the pluggable Code Review chain (Epic #2815)
 * to surface security-specific findings before a Story or Epic
 * merges. The adapter shells out to the host's `claude` CLI with a
 * prompt that wraps `/security-review` and asks for JSON-shaped
 * findings on stdout, then maps each entry onto the canonical
 * `Finding[]` contract so the existing `runCodeReview()` halting
 * gate ("any critical → halted: true") applies without a parallel
 * code path.
 *
 * Probe semantics: the provider checks for a `claude` binary on
 * PATH at construction. When absent, the constructor throws a
 * descriptive Error. The chain treats a constructor throw as a
 * skip when the entry was declared `optional: true` (the canonical
 * choice for `security-review` on non-Claude hosts), and as a
 * hard-fail when not.
 *
 * Output parsing is liberal: the provider accepts (a) a bare JSON
 * array, (b) `{findings: [...]}`, or (c) either shape wrapped in a
 * `result`/`data` envelope. Free-text output that does not parse as
 * JSON collapses to a single advisory `suggestion` finding pointing
 * the operator at the manual command — the chain still runs, but
 * the security signal is downgraded honestly rather than dropped.
 *
 * @typedef {import('./types.js').Finding}        Finding
 * @typedef {import('./types.js').ReviewInput}    ReviewInput
 * @typedef {import('./types.js').ReviewProvider} ReviewProvider
 * @typedef {import('./types.js').Severity}       Severity
 */

import { spawnSync } from 'node:child_process';
import { parseProviderFindings } from './parse-findings.js';
import { renderDepthDirective } from './review-depth.js';

/**
 * Canonical install/remediation guidance baked into every probe
 * failure. Exported so tests assert against the exact strings.
 */
export const SECURITY_REVIEW_REMEDIATIONS = Object.freeze({
  install:
    'Install the Claude Code CLI (https://docs.anthropic.com/en/docs/claude-code) ' +
    'so the host registers the `/security-review` built-in skill.',
  fallback:
    'Or mark this provider entry as `optional: true` in .agentrc.json so ' +
    'the chain skips it on hosts without the skill.',
});

/**
 * Default probe: returns true when `claude --version` exits cleanly.
 * Synchronous + cheap; the worst case (claude absent) MUST surface
 * at factory construction time so the operator sees the remediation
 * before the first review run.
 *
 * Exported for testing — tests inject a stub `probeFn` to bypass.
 *
 * @param {{ spawnFn?: typeof spawnSync }} [opts]
 * @returns {boolean}
 */
export function defaultProbeClaudeCli(opts = {}) {
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
 * Build the hard-fail Error thrown when the probe reports the
 * `claude` CLI is absent. Exported so the registry entry and tests
 * share one message shape.
 *
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
 * Severity vocabulary mapping. Mirrors `CODEX_SEVERITY_MAP` so
 * operators see a consistent severity-tier vocabulary regardless of
 * which adapter produced the finding.
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
 * Map a single security-review severity string onto the canonical
 * enum. Unknown / missing values collapse to `'suggestion'`.
 *
 * @param {unknown} raw
 * @returns {Severity}
 */
export function mapSecurityReviewSeverity(raw) {
  if (typeof raw !== 'string') return 'suggestion';
  const key = raw.trim().toLowerCase();
  return SECURITY_REVIEW_SEVERITY_MAP[key] ?? 'suggestion';
}

/**
 * Parse `/security-review` JSON output into `Finding[]`. Liberal:
 * accepts a bare array, `{findings: [...]}`, or either shape
 * wrapped in a `result`/`data` envelope. Free-text output that
 * fails to parse throws — the caller decides whether to fall back
 * to a single advisory finding.
 *
 * Exported for testing.
 *
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

/**
 * Prompt body sent to `claude --print` to wrap the built-in
 * `/security-review` skill with an explicit JSON-emit instruction.
 * Exported so doc tooling and tests reference one canonical string.
 *
 * The prompt is intentionally narrow: it asks the model to run the
 * skill against a specific git range and emit findings as a JSON
 * array. Any prose preface or trailing commentary is parseable as
 * "garbage before/after JSON" — `parseSecurityReviewFindings` uses
 * the first JSON-shaped substring rather than the whole stdout.
 *
 * The `{depthDirective}` slot renders the risk-derived thoroughness lever
 * (Story #3937) so a high-risk Epic instructs the model toward a deeper
 * second-pass review while a low-risk one keeps it light.
 */
export const SECURITY_REVIEW_INVOKE_PROMPT =
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
 * Build the `claude --print` prompt for a specific review input. The
 * risk-derived `depth` lever (Story #3937) is rendered into the prompt via
 * `renderDepthDirective` so the model's thoroughness tracks the Epic's judged
 * risk; an absent depth renders the `standard` directive.
 *
 * Exported for testing.
 *
 * @param {ReviewInput} input
 * @returns {string}
 */
export function buildSecurityReviewPrompt(input) {
  const scopeLabel = input?.scope === 'epic' ? 'Epic' : 'Story';
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
 * Default invoker: shell out to the host's `claude` CLI to run the
 * `/security-review` skill via a JSON-emit prompt. Exported for
 * testing — the production adapter accepts an `invokeFn` override
 * so tests never spawn a real process.
 *
 * @param {ReviewInput} input
 * @returns {{ status: number, stdout: string, stderr: string }}
 */
export function defaultInvokeSecurityReview(input) {
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
 * Build the advisory fallback finding emitted when `/security-review`
 * exits cleanly but its stdout is not parseable JSON. Pure +
 * exported so tests assert against the exact shape.
 *
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
 * Build a `ReviewProvider` instance backed by `/security-review`.
 *
 * @param {{
 *   probeFn?: () => boolean,
 *   invokeFn?: (input: ReviewInput) => { status: number, stdout: string, stderr: string },
 *   logger?: { info?: Function, warn?: Function, error?: Function },
 * }} [deps]
 * @returns {ReviewProvider}
 */
export function createSecurityReviewProvider(deps = {}) {
  const probeFn = deps.probeFn ?? defaultProbeClaudeCli;
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
 * Zero-arg factory entry point used by the `review-provider-factory`
 * registry. Mirrors `createCodexProviderForRegistry`.
 *
 * @returns {ReviewProvider}
 */
export function createSecurityReviewProviderForRegistry() {
  return createSecurityReviewProvider();
}
