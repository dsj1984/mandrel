/**
 * review-providers/codex.js — Codex ReviewProvider adapter.
 *
 * Story #2830 (Epic #2815) — wires the
 * [`openai/codex-plugin-cc`](https://github.com/openai/codex-plugin-cc)
 * Claude Code plugin's `/codex:review` slash command into the
 * pluggable ReviewProvider contract.
 *
 * Two halves shipped under one Story:
 *   - Task #2834 — schema enum + factory registration + hard-fail
 *     probe (this file's `createCodexProvider` + `*ForRegistry`).
 *   - Task #2836 — `runReview()` invokes `/codex:review --base <ref>
 *     --wait` through an injectable runner and parses the response
 *     into `Finding[]`, mapping the Codex severity vocabulary onto
 *     the canonical `critical|high|medium|suggestion` enum.
 *
 * The factory NEVER silently falls back to the native provider when
 * `provider: codex` is configured. Operators who want native MUST set
 * `provider: native` explicitly; the probe is the only thing that
 * routes between "configured backend present" and "configured backend
 * missing". The adapter never consults a GitHub provider — the
 * orchestrator owns posting/upserting and the lifecycle bus.
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

/**
 * Canonical install/remediation guidance baked into every probe failure.
 * Exported so tests (and any future error-renderer) can assert against
 * the exact remediations rather than free-text matching.
 */
export const CODEX_REMEDIATIONS = Object.freeze({
  install:
    'Install the Codex plugin (https://github.com/openai/codex-plugin-cc) ' +
    'so the host registers the `/codex:review` slash command.',
  fallback:
    'Or set `codeReview.providers` to [{ name: "native" }] in .agentrc.json to use the ' +
    'in-process maintainability/lint provider instead.',
});

/**
 * Default Codex plugin marker locations searched by the probe. The
 * Claude Code plugin manager (and its `claude plugin install` flow)
 * unpacks plugins under one of these roots; presence of the
 * `codex-plugin-cc` directory is treated as "the slash command is
 * registered on the host".
 *
 * Exported so tests can extend the list without monkey-patching `os`.
 */
export const DEFAULT_PLUGIN_MARKERS = Object.freeze([
  path.join(os.homedir(), '.claude', 'plugins', 'codex-plugin-cc'),
  path.join(os.homedir(), '.claude', 'plugins', 'openai', 'codex-plugin-cc'),
]);

/**
 * Default probe: returns true when any marker path exists on disk.
 *
 * The probe is intentionally cheap and synchronous — the factory runs
 * it at construction time and the worst case (plugin absent) MUST
 * surface immediately so the operator sees the remediation, not a
 * deferred runtime failure during the first review run.
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
      // Treat I/O errors as "absent" — the factory throws with the
      // remediation message, and the operator can inspect the path.
    }
  }
  return false;
}

/**
 * Build the hard-fail Error thrown when the probe reports the
 * `/codex:review` command is absent. Exported so the registry entry
 * and tests use the same message shape.
 *
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
 * Canonical severity table. Maps every Codex severity vocabulary
 * token (case-insensitive) onto the canonical ReviewProvider
 * `Severity` enum. The table is intentionally explicit — drop-through
 * to `'suggestion'` is reserved for tokens the table does NOT name.
 *
 * Exported so unit tests can drive a table-driven assertion across
 * every documented Codex severity without re-listing the mapping
 * inside the test file.
 *
 * @type {Readonly<Record<string, Severity>>}
 */
export const CODEX_SEVERITY_MAP = Object.freeze({
  // Codex "blocker" terminology → canonical critical (halts the
  // review with an unresolved-finding gate).
  blocker: 'critical',
  critical: 'critical',
  fatal: 'critical',
  // Codex "major" terminology → canonical high (lint-error
  // equivalent; non-halting but must be addressed before merge).
  major: 'high',
  high: 'high',
  error: 'high',
  // Codex "minor" terminology → canonical medium (size/volume
  // warning equivalent; flagged but not gating).
  minor: 'medium',
  medium: 'medium',
  warning: 'medium',
  // Codex "info" / "nit" / "style" → canonical suggestion
  // (advisory only, no gate).
  info: 'suggestion',
  nit: 'suggestion',
  style: 'suggestion',
  suggestion: 'suggestion',
  note: 'suggestion',
});

/**
 * Map a single Codex severity string onto the canonical enum.
 *
 * @param {unknown} raw
 * @returns {Severity}
 */
export function mapCodexSeverity(raw) {
  if (typeof raw !== 'string') return 'suggestion';
  const key = raw.trim().toLowerCase();
  return CODEX_SEVERITY_MAP[key] ?? 'suggestion';
}

/**
 * Parse the raw `/codex:review` stdout into `Finding[]`.
 *
 * The plugin emits JSON; the adapter is liberal in what it accepts:
 *   - A bare array of finding objects.
 *   - An object with a `findings` array.
 *   - Either shape wrapped in an outer envelope with a `result` or
 *     `data` key (covers minor wire-format drift across plugin
 *     versions without re-shimming).
 *
 * Each entry's severity is funnelled through `mapCodexSeverity` so
 * the canonical enum is the only thing that reaches the renderer.
 * Entries without a `title` or `body` are skipped — the orchestrator
 * cannot post an empty finding, and silently dropping the entry is
 * safer than fabricating one.
 *
 * Exported for testing.
 *
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
 * Build the `claude --print` prompt that invokes the `/codex:review` slash
 * command for a review input. The risk-derived `depth` lever (Story #3937) is
 * appended via `renderDepthDirective` so a high-risk Epic instructs Codex
 * toward a deeper second-pass review while a low-risk one keeps it light; an
 * absent depth renders the `standard` directive. The `/codex:review` slash
 * command and its `--wait` flag are unchanged — the directive rides as
 * trailing prompt prose the plugin's wrapping model reads.
 *
 * Pure. Exported for testing.
 *
 * @param {{ baseRef: string, headRef: string, depth?: import('./types.js').ReviewDepth }} args
 * @returns {string}
 */
export function buildCodexReviewPrompt({ baseRef, headRef, depth }) {
  return (
    `/codex:review --base ${baseRef} --head ${headRef} --wait ` +
    `${renderDepthDirective(depth)}`
  );
}

/**
 * Default invoker: shell out to the host's `claude` CLI to run the
 * `/codex:review` slash command. The plugin is expected to print a
 * JSON document to stdout when `--wait` is passed; non-zero exits
 * propagate as an Error so the orchestrator records the run as
 * `status=invalid` rather than burying the failure.
 *
 * Exported for testing — the production adapter accepts an
 * `invokeFn` override so tests never spawn a real process.
 *
 * @param {{ baseRef: string, headRef: string, depth?: import('./types.js').ReviewDepth }} args
 * @returns {{ status: number, stdout: string, stderr: string }}
 */
export function defaultInvokeCodexReview({ baseRef, headRef, depth }) {
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
 * Build a `ReviewProvider` instance backed by the Codex plugin.
 *
 * The `deps` overload is the test seam — production callers (the
 * factory) invoke `createCodexProvider()` with no arguments and get
 * the default dependency chain (probe via plugin marker, invoker via
 * the `claude` CLI). Tests inject `probeFn` (to bypass the marker
 * check) and `invokeFn` (to return canned stdout).
 *
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
 * Zero-arg factory entry point used by the `review-provider-factory`
 * registry. Mirrors `createNativeProviderForRegistry` so the registry
 * signature stays `() => ReviewProvider`.
 *
 * @returns {ReviewProvider}
 */
export function createCodexProviderForRegistry() {
  return createCodexProvider();
}
