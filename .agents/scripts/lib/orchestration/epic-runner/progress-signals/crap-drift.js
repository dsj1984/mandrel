import nodeFs from 'node:fs';
import path from 'node:path';
import { loadCoverage as defaultLoadCoverage } from '../../../coverage-utils.js';
import { calculateCrapForSource } from '../../../crap-engine.js';

const DEFAULT_THRESHOLD = 5.0;
const DEFAULT_CEILING = 30;
// Distinct from the canonical ratchet baseline at `baselines/crap.json`
// (Epic #730 Story 5.5) — this is a per-wave drift SNAPSHOT, not the
// committed score baseline. Filename intentionally differs so a repo-wide
// grep for the canonical baseline no longer hits the snapshot.
const BASELINE_FILENAME = 'wave-crap-snapshot.json';

/**
 * Normalise a repo-relative path for coverage-key lookup. Pure; exported
 * for unit tests so the underlying branches don't have to be exercised
 * through the closure-bound `findCoverageEntry`.
 */
export function normaliseCoveragePath(relPath) {
  return String(relPath)
    .replace(/\\/g, '/')
    .replace(/^\.\/+/, '');
}

/**
 * True when a coverage map key matches a (normalised) relative path,
 * either by full equality or by suffix-with-slash. Pure.
 */
export function coverageKeyMatches(key, suffix) {
  const norm = String(key).replace(/\\/g, '/');
  return norm === suffix || norm.endsWith(`/${suffix}`);
}

/**
 * Detects per-method CRAP drift versus a wave-start baseline.
 *
 * Mirrors the `maintainability-drift.js` contract but at per-method
 * granularity: baseline snapshots are `{ "<file>::<method>@<startLine>": crap }`
 * rather than a single score per file. A method surfaces as a Notable bullet
 * when either condition holds:
 *
 *   - **Crossed the ceiling** — current CRAP ≥ `ceiling` and baseline was
 *     either absent or below `ceiling`. Captures newly introduced hotspots
 *     and methods that tipped over the budget.
 *   - **Rose by ≥ threshold** — baseline present and `current - baseline ≥
 *     threshold`. Captures silent regressions that stay under the ceiling
 *     but are trending badly.
 *
 * Bullet shape:
 *
 *   🧨 CRAP drift: <file>::<method> <score> (ceiling <N>)
 *
 * Persistence: baseline is written to `<cwd>/<baselineDir>/wave-crap-snapshot.json`
 * so a resumed epic run can reuse the wave-start anchor rather than lose it.
 *
 * Resilience: read / scoring errors for an individual file are swallowed (and
 * optionally logged) so a single unscorable file cannot take the progress
 * reporter down.
 *
 * @param {{
 *   cwd?: string,
 *   files?: string[],
 *   fs?: { readFileSync: Function, writeFileSync?: Function, mkdirSync?: Function, existsSync?: Function },
 *   calculate?: (source: string, coverageForFile: object|null) => Array<{ method: string, startLine: number, crap: number|null }>,
 *   loadCoverage?: (coveragePath: string) => object|null,
 *   coveragePath?: string | null,
 *   threshold?: number,
 *   ceiling?: number,
 *   baselineDir?: string,
 *   logger?: { warn?: Function },
 * }} [opts]
 */
export function createCrapDriftDetector(opts = {}) {
  const fs = opts.fs ?? nodeFs;
  const cwd = opts.cwd ?? process.cwd();
  const files = Array.isArray(opts.files) ? [...opts.files] : [];
  const calculate = opts.calculate ?? calculateCrapForSource;
  const loadCoverage = opts.loadCoverage ?? defaultLoadCoverage;
  const coveragePath = opts.coveragePath ?? null;
  const threshold = Number.isFinite(opts.threshold)
    ? opts.threshold
    : DEFAULT_THRESHOLD;
  const ceiling = Number.isFinite(opts.ceiling)
    ? opts.ceiling
    : DEFAULT_CEILING;
  const baselineDir = opts.baselineDir ?? '.agents/state';
  const baselinePath = path.join(cwd, baselineDir, BASELINE_FILENAME);
  const logger = opts.logger ?? null;

  let baseline = null;

  function methodKey(method, startLine) {
    return `${method}@${startLine}`;
  }

  // Hoisted helpers — exported via `_internal` for unit coverage on each
  // branch. Keeping them outside the closure keeps the orchestration
  // method's complexity low.
  // (see normaliseCoveragePath / coverageKeyMatches at module top.)
  function findCoverageEntry(coverageMap, relPath) {
    if (!coverageMap || typeof coverageMap !== 'object') return null;
    const suffix = normaliseCoveragePath(relPath);
    if (!suffix) return null;
    for (const key of Object.keys(coverageMap)) {
      if (coverageKeyMatches(key, suffix)) {
        return coverageMap[key] ?? null;
      }
    }
    return null;
  }

  function scoreFile(relPath, coverageMap) {
    try {
      const abs = path.join(cwd, relPath);
      const src = fs.readFileSync(abs, 'utf-8');
      const entry = findCoverageEntry(coverageMap, relPath);
      const rows = calculate(src, entry) ?? [];
      const methods = {};
      for (const row of rows) {
        if (!row || typeof row.method !== 'string') continue;
        if (typeof row.startLine !== 'number') continue;
        if (typeof row.crap !== 'number' || !Number.isFinite(row.crap))
          continue;
        methods[methodKey(row.method, row.startLine)] = {
          method: row.method,
          startLine: row.startLine,
          crap: row.crap,
        };
      }
      return methods;
    } catch (err) {
      logger?.warn?.(
        `[crap-drift] scoring failed for ${relPath}: ${err?.message ?? err}`,
      );
      return null;
    }
  }

  function readCoverageMap() {
    if (!coveragePath) return null;
    try {
      return loadCoverage(coveragePath);
    } catch (err) {
      logger?.warn?.(
        `[crap-drift] coverage load failed (${coveragePath}): ${err?.message ?? err}`,
      );
      return null;
    }
  }

  return {
    get baselinePath() {
      return baselinePath;
    },

    captureBaseline() {
      const coverageMap = readCoverageMap();
      const snapshot = {};
      for (const f of files) {
        const methods = scoreFile(f, coverageMap);
        if (!methods) continue;
        snapshot[f] = {};
        for (const [key, row] of Object.entries(methods)) {
          snapshot[f][key] = row.crap;
        }
      }
      baseline = snapshot;
      if (fs.writeFileSync) {
        try {
          fs.mkdirSync?.(path.dirname(baselinePath), { recursive: true });
          fs.writeFileSync(
            baselinePath,
            JSON.stringify(
              {
                capturedAt: new Date().toISOString(),
                ceiling,
                threshold,
                scores: snapshot,
              },
              null,
              2,
            ),
          );
        } catch {
          // persistence is best-effort; the in-memory baseline still works
        }
      }
      return snapshot;
    },

    loadBaseline() {
      if (!fs.readFileSync) return null;
      try {
        const raw = fs.readFileSync(baselinePath, 'utf-8');
        const parsed = JSON.parse(raw);
        baseline = parsed?.scores ?? null;
        return baseline;
      } catch {
        return null;
      }
    },

    async detect() {
      if (!baseline) return [];
      const coverageMap = readCoverageMap();
      const bullets = [];
      const base = baseline;
      // Union of files watched and files present in baseline, so methods that
      // appeared since the snapshot (new files) are still checked, and methods
      // that disappeared from baseline-only files don't get us stuck iterating
      // anything spurious.
      const fileSet = new Set([...files, ...Object.keys(base)]);
      for (const relPath of fileSet) {
        const currentMethods = scoreFile(relPath, coverageMap);
        if (!currentMethods) continue;
        const fileBaseline = base[relPath] ?? {};
        for (const [key, row] of Object.entries(currentMethods)) {
          const prev = fileBaseline[key];
          const crossed =
            row.crap >= ceiling &&
            (prev === undefined || prev === null || prev < ceiling);
          const rose =
            typeof prev === 'number' &&
            Number.isFinite(prev) &&
            row.crap - prev >= threshold;
          if (crossed || rose) {
            bullets.push(
              `🧨 CRAP drift: ${relPath}::${row.method} ${row.crap.toFixed(2)} (ceiling ${ceiling})`,
            );
          }
        }
      }
      return bullets;
    },
  };
}
