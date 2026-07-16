/**
 * dead-exports-mode.js — the two passes of the dead-export ratchet.
 *
 * The gate runs twice with different reachability assumptions, and each pass
 * needs a matched triple: which knip invocation to make, which baseline to
 * ratchet against, and how to label its output. Resolving that triple in one
 * place keeps the three from drifting apart — a pass that ran production knip
 * against the default baseline would report every test-only export as newly
 * dead and fail the build for no reason.
 *
 * - **default** — `tests/**` are knip entry points, so an export imported only
 *   by a test reads as used. This is the historical gate.
 * - **production** — knip's `--production` drops the test entries, so an export
 *   no production code reaches reads as dead. Depends on the `!` pattern
 *   suffixes in `knip.json`; without them production mode has no entry points
 *   and silently reports nothing.
 *
 * The two ratchet against separate baselines on purpose. This repo sanctions
 * exporting purely for a test (`.agents/rules/test-seams.md`), so the
 * production row set is large and mostly intentional; merging it into the
 * default baseline would destroy that baseline's meaning.
 *
 * @module lib/dead-exports-mode
 */

import path from 'node:path';

/** Baseline for the default pass (test entry points included). */
const DEFAULT_BASELINE = path.join('baselines', 'dead-exports.json');

/** Baseline for the `--production` pass (test-only-importer discount). */
const PRODUCTION_BASELINE = path.join(
  'baselines',
  'dead-exports-production.json',
);

/**
 * Resolve the baseline / label / mode-tag triple for a pass.
 *
 * @param {boolean} production
 * @returns {{ mode: 'production'|'default', label: string, baseline: string }}
 */
export function resolveDeadExportsMode(production) {
  return production
    ? {
        mode: 'production',
        label: 'dead-exports:production',
        baseline: PRODUCTION_BASELINE,
      }
    : { mode: 'default', label: 'dead-exports', baseline: DEFAULT_BASELINE };
}
