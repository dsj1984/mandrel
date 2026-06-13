import nodeFs from 'node:fs';
import path from 'node:path';

import { calculateForSource } from '../../../maintainability-engine.js';
import { formatNumber } from './_bullet-format.js';
import {
  createDriftDetector,
  walkComponentRegressions,
} from './component-drift.js';

const DEFAULT_THRESHOLD = 2.0;
// Distinct from the canonical ratchet baseline at `baselines/maintainability.json`
// (Epic #730 Story 5.5) — this file is a per-wave drift SNAPSHOT, not the
// committed score baseline. Filename intentionally differs so a repo-wide
// grep for the canonical baseline no longer hits the snapshot.
const BASELINE_FILENAME = 'wave-mi-snapshot.json';

/**
 * Detect per-component maintainability regressions from a baseline rollup
 * against the gate's configured floors. Pure — the caller loads the
 * baseline via `lib/baselines/reader.js#load('maintainability')` and passes
 * the resulting `{ rollup }` plus the gate config block.
 *
 * Bullet shape (Task #1919, Epic #1786):
 *
 *   📉 maintainability: <component> <axis> <value> < floor <floor>
 *
 * Maintainability is "higher is better" — every axis breach reports when
 * `value < floor`. Component-scoped breaches do NOT trigger a `*` bullet
 * unless `*` itself breaches. The walk itself is the shared
 * `component-drift.js` helper (Story #3984).
 *
 * @param {{
 *   rollup?: Record<string, Record<string, number>>,
 *   gateConfig?: { floors?: Record<string, Record<string, number>> } & object,
 * }} params
 * @returns {string[]}
 */
export function detectComponentRegressions(params = {}) {
  return walkComponentRegressions(params, {
    isBreach: (value, target) => value < target,
    formatBullet: (name, axis, value, target) =>
      `📉 maintainability: ${name} ${axis} ${formatNumber(value)} < floor ${formatNumber(target)}`,
  });
}

/**
 * Detects per-file maintainability drop versus a wave-start baseline.
 *
 * Usage:
 *   const detector = createMaintainabilityDriftDetector({ cwd, files });
 *   detector.captureBaseline();   // call once at wave-start
 *   await detector.detect(rows);  // call each progress fire
 *
 * A baseline is a map of file -> score, persisted to
 * `<cwd>/<baselineDir>/wave-mi-snapshot.json` so that a resumed epic
 * run can re-read the snapshot from the previous wave rather than lose the
 * anchor. Any file whose score has dropped by >= `threshold` since baseline
 * is surfaced as a bullet:
 *
 *   📉 Maintainability drift: <file> -<n.nn> vs wave-start baseline
 *
 * Errors while reading/scoring individual files are swallowed — a single
 * bad file must not take the progress reporter down.
 *
 * @param {{
 *   cwd?: string,
 *   files?: string[],               // files to watch; repo-relative paths
 *   fs?: { readFileSync: Function, writeFileSync?: Function, mkdirSync?: Function, existsSync?: Function },
 *   calculate?: (source: string) => number,
 *   threshold?: number,             // drop (baseline - current) that trips a bullet
 *   baselineDir?: string,           // directory (under cwd) to persist snapshot
 * }} [opts]
 */
export function createMaintainabilityDriftDetector(opts = {}) {
  const fs = opts.fs ?? nodeFs;
  const cwd = opts.cwd ?? process.cwd();
  const calculate = opts.calculate ?? calculateForSource;
  const threshold = Number.isFinite(opts.threshold)
    ? opts.threshold
    : DEFAULT_THRESHOLD;

  function scoreFile(relPath) {
    try {
      const abs = path.join(cwd, relPath);
      const src = fs.readFileSync(abs, 'utf-8');
      const score = calculate(src);
      return Number.isFinite(score) ? score : null;
    } catch {
      return null;
    }
  }

  return createDriftDetector({
    fs,
    cwd,
    files: opts.files,
    baselineDir: opts.baselineDir,
    baselineFilename: BASELINE_FILENAME,
    scoreFile,
    captureScore: (score) => score,
    async detect({ baseline, scoreFile: score }) {
      const bullets = [];
      for (const [relPath, baseScore] of Object.entries(baseline)) {
        const current = score(relPath);
        if (current == null) continue;
        const drop = baseScore - current;
        if (drop >= threshold) {
          bullets.push(
            `📉 Maintainability drift: ${relPath} -${drop.toFixed(2)} vs wave-start baseline`,
          );
        }
      }
      return bullets;
    },
  });
}
