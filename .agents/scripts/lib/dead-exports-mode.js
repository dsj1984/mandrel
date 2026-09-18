/**
 * dead-exports-mode.js — the matched knip-mode / baseline / label triple for
 * each dead-export pass; mixing them (production knip against the default
 * baseline) would flag every test-only export as newly dead. Separate
 * baselines on purpose: exporting for tests is sanctioned, so the production
 * row set is large and mostly intentional.
 *
 * @module lib/dead-exports-mode
 */

import path from 'node:path';

const DEFAULT_BASELINE = path.join('baselines', 'dead-exports.json');

const PRODUCTION_BASELINE = path.join(
  'baselines',
  'dead-exports-production.json',
);

/**
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
