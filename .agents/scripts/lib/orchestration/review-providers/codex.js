/**
 * review-providers/codex.js — Codex ReviewProvider adapter.
 *
 * Story #2830 (Epic #2815) — wires the
 * [`openai/codex-plugin-cc`](https://github.com/openai/codex-plugin-cc)
 * Claude Code plugin's `/codex:review` slash command into the
 * pluggable ReviewProvider contract.
 *
 * This file ships with Task #2834 in the form needed by the
 * `review-provider-factory` registry: a probe function plus a
 * zero-arg constructor that throws a hard-fail Error (naming both
 * remediations) when the plugin's `/codex:review` command is not
 * registered on the host. Task #2836 (same Story) lands the full
 * `runReview()` implementation and the severity-vocabulary parser.
 *
 * The factory NEVER silently falls back to the native provider when
 * `provider: codex` is configured. Operators who want native MUST set
 * `provider: native` explicitly; the probe is the only thing that
 * routes between "configured backend present" and "configured backend
 * missing".
 *
 * @typedef {import('./types.js').Finding} Finding
 * @typedef {import('./types.js').ReviewInput} ReviewInput
 * @typedef {import('./types.js').ReviewProvider} ReviewProvider
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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
    'Or set `codeReview.provider` to "native" in .agentrc.json to use the ' +
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
    '[ReviewProviderFactory] codeReview.provider is set to "codex" but the ' +
      '`/codex:review` slash command is not registered on this host. ' +
      `${CODEX_REMEDIATIONS.install} ${CODEX_REMEDIATIONS.fallback}`,
  );
}

/**
 * Build a `ReviewProvider` instance backed by the Codex plugin.
 *
 * Task #2834 ships the probe + registry wiring; Task #2836 replaces
 * the `runReview()` stub with the real `/codex:review --base <ref>
 * --wait` invocation and the severity-vocabulary parser. Until #2836
 * lands, `runReview()` throws so a misconfigured deployment fails
 * loudly rather than silently emitting empty findings.
 *
 * @param {{ probeFn?: () => boolean }} [deps]
 * @returns {ReviewProvider}
 */
export function createCodexProvider(deps = {}) {
  const probeFn = deps.probeFn ?? defaultProbeCodexCommand;
  if (!probeFn()) {
    throw buildCodexUnavailableError();
  }

  return {
    /**
     * @param {ReviewInput} _input
     * @returns {Promise<Finding[]>}
     */
    async runReview(_input) {
      throw new Error(
        '[codex-review] runReview() is not yet implemented. ' +
          'Task #2836 (Story #2830, Epic #2815) lands the `/codex:review` ' +
          'invocation and the Codex-severity parser.',
      );
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
