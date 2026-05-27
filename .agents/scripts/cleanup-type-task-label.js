/**
 * cleanup-type-task-label.js — Remove the `type::task` label from a consumer
 * repository.
 *
 * Story #3103 (Epic #3078). The 3-tier hierarchy collapses
 * Epic → Feature → Story → Task into Epic → Feature → Story; the
 * `type::task` label is therefore obsolete. This one-shot utility deletes
 * the label from a consumer repo and is safe to re-run (idempotent).
 *
 * Usage:
 *   node .agents/scripts/cleanup-type-task-label.js
 *   node .agents/scripts/cleanup-type-task-label.js --dry-run
 *
 * Reads `github.owner` and `github.repo` from `.agentrc.json` via the
 * canonical config resolver. The script is dependency-injectable for
 * tests via the `{ provider }` option on the exported
 * `cleanupTypeTaskLabel` function — production calls go through the real
 * GitHub provider, contract tests inject a stub.
 *
 * Exit codes:
 *   0 — label removed, or label already absent (no-op).
 *   1 — unrecoverable error (config invalid, GitHub call failed).
 */

import { runAsCli } from './lib/cli-utils.js';
import { resolveConfig } from './lib/config-resolver.js';
import { Logger } from './lib/Logger.js';
import { createProvider } from './lib/provider-factory.js';

const TARGET_LABEL = 'type::task';

/**
 * Default provider adapter used when callers do not inject one. Wraps the
 * GitHub provider's `_gh.exec` surface to issue `repos/{owner}/{repo}/labels/{name}`
 * DELETE calls. Production code path.
 *
 * @param {object} config - The resolved config wrapper (`resolveConfig()`).
 * @returns {{ deleteLabel: (name: string) => Promise<{ removed: boolean }> }}
 */
export function defaultProvider(config) {
  const provider = createProvider(config);
  const owner = config.github.owner;
  const repo = config.github.repo;
  return {
    async deleteLabel(name) {
      try {
        await provider._gh.api([
          '-X',
          'DELETE',
          `repos/${owner}/${repo}/labels/${encodeURIComponent(name)}`,
        ]);
        return { removed: true };
      } catch (err) {
        if (isLabelNotFoundError(err)) return { removed: false };
        throw err;
      }
    },
  };
}

/**
 * Detect the "label not found" signal from `gh api` so a missing label
 * (the idempotent re-run case) is treated as success. The CLI prints
 * `HTTP 404` to stderr and the response body carries `Not Found`.
 *
 * @param {Error & { stderr?: string }} err
 * @returns {boolean}
 */
export function isLabelNotFoundError(err) {
  if (!err) return false;
  const stderr = err.stderr ?? '';
  const message = err.message ?? '';
  return /HTTP\s+404/i.test(stderr + message) || /Not Found/i.test(stderr);
}

/**
 * Remove the `type::task` label from a target repo.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.dryRun=false] - When true, no GitHub mutation runs.
 * @param {object} [opts.config] - Pre-resolved config (test seam).
 * @param {{ deleteLabel: (name: string) => Promise<{ removed: boolean }> }} [opts.provider]
 *   - Injected provider (test seam).
 * @returns {Promise<{ ok: true, action: 'dry-run'|'removed'|'no-op', label: string, message: string }>}
 */
export async function cleanupTypeTaskLabel(opts = {}) {
  const dryRun = Boolean(opts.dryRun);
  const config = opts.config ?? resolveConfig();
  if (!config?.github?.owner || !config?.github?.repo) {
    throw new Error(
      '[cleanup-type-task-label] Missing github.owner / github.repo in .agentrc.json',
    );
  }

  if (dryRun) {
    return {
      ok: true,
      action: 'dry-run',
      label: TARGET_LABEL,
      message: `[dry-run] Would delete label "${TARGET_LABEL}" from ${config.github.owner}/${config.github.repo}`,
    };
  }

  const provider = opts.provider ?? defaultProvider(config);
  const result = await provider.deleteLabel(TARGET_LABEL);
  if (result.removed) {
    return {
      ok: true,
      action: 'removed',
      label: TARGET_LABEL,
      message: `Deleted label "${TARGET_LABEL}" from ${config.github.owner}/${config.github.repo}`,
    };
  }
  return {
    ok: true,
    action: 'no-op',
    label: TARGET_LABEL,
    message: `Label "${TARGET_LABEL}" already absent from ${config.github.owner}/${config.github.repo} (no-op)`,
  };
}

/**
 * Parse CLI argv into the option bag accepted by `cleanupTypeTaskLabel`.
 *
 * @param {string[]} argv
 * @returns {{ dryRun: boolean }}
 */
export function parseArgs(argv) {
  return { dryRun: argv.includes('--dry-run') };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const result = await cleanupTypeTaskLabel(opts);
  Logger.info(`[cleanup-type-task-label] ${result.message}`);
  console.log(JSON.stringify(result, null, 2));
}

runAsCli(import.meta.url, main, { source: 'cleanup-type-task-label' });
