/**
 * review-providers/codex.js — ReviewProvider over `/codex:review`. A missing
 * plugin hard-fails at construction; never a silent fallback to native.
 *
 * @typedef {import('./types.js').Finding} Finding
 * @typedef {import('./types.js').ReviewInput} ReviewInput
 * @typedef {import('./types.js').ReviewProvider} ReviewProvider
 * @typedef {import('./types.js').Severity} Severity
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseProviderFindings } from './parse-findings.js';
import { renderDepthDirective } from './review-depth.js';

export const CODEX_REMEDIATIONS = Object.freeze({
  install:
    'Install the Codex plugin (https://github.com/openai/codex-plugin-cc) ' +
    'so the host registers the `/codex:review` slash command.',
  fallback:
    'Or set `codeReview.providers` to [{ name: "native" }] in .agentrc.json to use the ' +
    'in-process maintainability/lint provider instead.',
});

/** A present `codex-plugin-cc` directory means the slash command is registered. */
const DEFAULT_PLUGIN_MARKERS = Object.freeze([
  path.join(os.homedir(), '.claude', 'plugins', 'codex-plugin-cc'),
  path.join(os.homedir(), '.claude', 'plugins', 'openai', 'codex-plugin-cc'),
]);

/**
 * Synchronous so a missing plugin surfaces at construction, not mid-review.
 *
 * @param {{ markers?: readonly string[], existsFn?: (p: string) => boolean }} [opts]
 * @returns {boolean}
 */
export function defaultProbeCodexCommand(opts = {}) {
  const markers = opts.markers ?? DEFAULT_PLUGIN_MARKERS;
  const existsFn = opts.existsFn ?? fs.existsSync;
  for (const marker of markers) {
    try {
      if (existsFn(marker)) return true;
    } catch (_err) {
      // An I/O error reads as absent.
    }
  }
  return false;
}

/**
 * @returns {Error}
 */
export function buildCodexUnavailableError() {
  return new Error(
    '[ReviewProviderFactory] codeReview.providers includes "codex" but the ' +
      '`/codex:review` slash command is not registered on this host. ' +
      `${CODEX_REMEDIATIONS.install} ${CODEX_REMEDIATIONS.fallback}`,
  );
}

/**
 * Codex severity tokens (case-insensitive) → canonical `Severity`; an
 * unnamed token falls through to `'suggestion'`.
 *
 * @type {Readonly<Record<string, Severity>>}
 */
export const CODEX_SEVERITY_MAP = Object.freeze({
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
export function mapCodexSeverity(raw) {
  if (typeof raw !== 'string') return 'suggestion';
  const key = raw.trim().toLowerCase();
  return CODEX_SEVERITY_MAP[key] ?? 'suggestion';
}

/**
 * @param {string} rawStdout
 * @returns {Finding[]}
 * @throws {Error} when stdout is not parseable JSON.
 */
export function parseCodexFindings(rawStdout) {
  return parseProviderFindings(rawStdout, {
    errorPrefix: '[codex-review] Failed to parse /codex:review stdout as JSON',
    mapSeverity: mapCodexSeverity,
  });
}

/**
 * The depth directive rides as trailing prompt prose after the slash command.
 *
 * @param {{ baseRef: string, headRef: string, depth?: import('./types.js').ReviewDepth }} args
 * @returns {string}
 */
function buildCodexReviewPrompt({ baseRef, headRef, depth }) {
  return (
    `/codex:review --base ${baseRef} --head ${headRef} --wait ` +
    `${renderDepthDirective(depth)}`
  );
}

/**
 * Run `/codex:review` through the host's `claude` CLI; `--wait` makes the
 * plugin print JSON to stdout.
 *
 * @param {{ baseRef: string, headRef: string, depth?: import('./types.js').ReviewDepth }} args
 * @returns {{ status: number, stdout: string, stderr: string }}
 */
function defaultInvokeCodexReview({ baseRef, headRef, depth }) {
  const cliArgs = [
    '--print',
    buildCodexReviewPrompt({ baseRef, headRef, depth }),
  ];
  const result = spawnSync('claude', cliArgs, {
    encoding: 'utf-8',
    shell: process.platform === 'win32',
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

/**
 * @param {{
 *   probeFn?: () => boolean,
 *   invokeFn?: (args: { baseRef: string, headRef: string, scope: string, ticketId: number, depth?: import('./types.js').ReviewDepth }) => { status: number, stdout: string, stderr: string },
 *   logger?: { info?: Function, warn?: Function, error?: Function },
 * }} [deps]
 * @returns {ReviewProvider}
 */
export function createCodexProvider(deps = {}) {
  const probeFn = deps.probeFn ?? defaultProbeCodexCommand;
  if (!probeFn()) {
    throw buildCodexUnavailableError();
  }

  const invokeFn = deps.invokeFn ?? defaultInvokeCodexReview;
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
        `[codex-review] Invoking /codex:review --base ${baseRef} --head ${headRef} ` +
          `for ${scope} #${ticketId}...`,
      );

      const result = invokeFn({ baseRef, headRef, scope, ticketId, depth });
      if (result.status !== 0) {
        throw new Error(
          `[codex-review] /codex:review exited with status ${result.status}: ${
            result.stderr || result.stdout || '<no output>'
          }`,
        );
      }

      const findings = parseCodexFindings(result.stdout);
      logger?.info?.(
        `[codex-review] Parsed ${findings.length} finding(s) from /codex:review.`,
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
