/**
 * Per-file coverage floors in `baselines/coverage.json`, scoped by the c8
 * `include`/`exclude` globs (coverage-final.json holds every instrumented file).
 */

import fs from 'node:fs';
import path from 'node:path';
import picomatch from 'picomatch';
import { write, writeFile } from './baselines/writer.js';

const COVERAGE_FINAL_PATH = 'coverage/coverage-final.json';
export const COVERAGE_BASELINE_PATH = 'baselines/coverage.json';
// Percentage points; baselines store two decimals.
export const COVERAGE_TOLERANCE = 0.01;
// One instrumentation event of slack per axis: V8 coverage flaps by a single
// event between runs (notably Windows/Node 22).
const NOISE_EVENT_HEADROOM = 1.0;

function toForwardSlash(p) {
  return p.replace(/\\/g, '/');
}

/** c8's scope rule: some `include` matches and no `exclude` does. */
export function buildScopePredicate({ include = [], exclude = [] } = {}) {
  const inc =
    include.length === 0 ? () => true : picomatch(include, { dot: true });
  const exc =
    exclude.length === 0 ? () => false : picomatch(exclude, { dot: true });
  return (relPath) => {
    const norm = toForwardSlash(relPath);
    return inc(norm) && !exc(norm);
  };
}

/**
 * Percentages as `c8 check-coverage` defines them; an axis with no
 * denominator is `null` (a no-op when comparing).
 */
export function scoreEntry(entry) {
  const sMap = entry?.s ?? {};
  const bMap = entry?.b ?? {};
  const fMap = entry?.f ?? {};

  let lT = 0;
  let lC = 0;
  for (const v of Object.values(sMap)) {
    lT += 1;
    if (v > 0) lC += 1;
  }
  let bT = 0;
  let bC = 0;
  for (const arr of Object.values(bMap)) {
    if (!Array.isArray(arr)) continue;
    for (const v of arr) {
      bT += 1;
      if (v > 0) bC += 1;
    }
  }
  let fT = 0;
  let fC = 0;
  for (const v of Object.values(fMap)) {
    fT += 1;
    if (v > 0) fC += 1;
  }
  const pct = (c, t) => (t === 0 ? null : Number(((100 * c) / t).toFixed(2)));
  return {
    lines: pct(lC, lT),
    branches: pct(bC, bT),
    functions: pct(fC, fT),
    denominators: { lines: lT, branches: bT, functions: fT },
  };
}

/** In-scope entries keyed by repo-relative path (raw keys are absolute). */
export function scoreCoverageFinal({ raw, cwd, scope }) {
  const inScope = scope ?? buildScopePredicate({});
  const out = {};
  for (const [absPath, entry] of Object.entries(raw ?? {})) {
    const rel = toForwardSlash(path.relative(cwd, absPath));
    if (!inScope(rel)) continue;
    out[rel] = scoreEntry(entry);
  }
  return out;
}

/** Throws, naming the capture command, when the artifact is missing. */
export function readCoverageFinal(cwd, opts = {}, fsImpl) {
  const resolvedFs = fsImpl ?? fs;
  const coveragePath =
    typeof opts === 'string'
      ? opts
      : (opts?.coveragePath ?? COVERAGE_FINAL_PATH);
  const abs = path.isAbsolute(coveragePath)
    ? coveragePath
    : path.resolve(cwd, coveragePath);
  if (!resolvedFs.existsSync(abs)) {
    throw new Error(
      `coverage-final.json not found at ${abs}. Run \`npm run test:coverage\` first.`,
    );
  }
  return JSON.parse(resolvedFs.readFileSync(abs, 'utf8'));
}

function isEnvelopeShape(parsed) {
  return (
    parsed &&
    typeof parsed === 'object' &&
    !Array.isArray(parsed) &&
    Array.isArray(parsed.rows) &&
    typeof parsed.$schema === 'string'
  );
}

function projectEnvelopeToFlat(envelope) {
  const out = {};
  for (const row of envelope.rows) {
    if (!row || typeof row.path !== 'string') continue;
    out[row.path] = {
      lines: row.lines,
      branches: row.branches,
      functions: row.functions,
    };
  }
  return out;
}

function normaliseParsedBaseline(parsed) {
  // Readers expect the flat `{ file: scores }` map, not the envelope.
  return isEnvelopeShape(parsed) ? projectEnvelopeToFlat(parsed) : parsed;
}

/**
 * `null` (not `{}`) when missing: "no baseline yet" passes with a warning,
 * while an empty baseline fails every in-scope file as new.
 */
export function readBaseline(cwd, fsImpl = fs) {
  const abs = path.resolve(cwd, COVERAGE_BASELINE_PATH);
  if (!fsImpl.existsSync(abs)) return null;
  return normaliseParsedBaseline(JSON.parse(fsImpl.readFileSync(abs, 'utf8')));
}

function projectFlatToRows(baseline) {
  return Object.entries(baseline ?? {}).map(([file, scores]) => {
    const { denominators: _ignored, ...rest } = scores ?? {};
    return {
      path: file,
      lines: rest.lines ?? 0,
      branches: rest.branches ?? 0,
      functions: rest.functions ?? 0,
    };
  });
}

function writeEnvelopeViaFsImpl(abs, envelope, fsImpl) {
  fsImpl.mkdirSync(path.dirname(abs), { recursive: true });
  const canonical = {
    $schema: envelope.$schema,
    kernelVersion: envelope.kernelVersion,
    generatedAt: envelope.generatedAt,
    rollup: envelope.rollup,
    rows: envelope.rows,
  };
  fsImpl.writeFileSync(abs, `${JSON.stringify(canonical, null, 2)}\n`);
}

function dispatchEnvelopeWrite(abs, envelope, fsImpl) {
  return fsImpl === fs
    ? writeFile(abs, envelope)
    : writeEnvelopeViaFsImpl(abs, envelope, fsImpl);
}

// Prior rows for the epsilon/scope merge; `null` on any read failure.
function readPriorRows(abs, fsImpl) {
  try {
    const parsed = JSON.parse(fsImpl.readFileSync(abs, 'utf8'));
    return Array.isArray(parsed?.rows) ? parsed.rows : null;
  } catch {
    return null;
  }
}

export function writeBaseline(cwd, baseline, fsImpl = fs, opts = {}) {
  const abs = path.resolve(cwd, COVERAGE_BASELINE_PATH);
  const prior =
    opts.prior !== undefined ? opts.prior : readPriorRows(abs, fsImpl);
  const envelope = write({
    kind: 'coverage',
    rows: projectFlatToRows(baseline),
    prior: prior ?? undefined,
    epsilon: prior && opts.epsilon !== undefined ? opts.epsilon : undefined,
    scope: opts.scope,
  });
  dispatchEnvelopeWrite(abs, envelope, fsImpl);
  return abs;
}

/** Per-axis tolerance: at least one event's worth (`100/N` points). */
export function axisToleranceFor(
  denominator,
  baseTolerance = COVERAGE_TOLERANCE,
) {
  if (!Number.isFinite(denominator) || denominator <= 0) return baseTolerance;
  const eventResolution = 100 / denominator;
  return Math.max(baseTolerance, eventResolution * NOISE_EVENT_HEADROOM);
}

/**
 * Classify files: `regressions` (an axis dropped beyond tolerance) and
 * `newFiles` (else untested code lands at 0%) fail the CLI; `removedFiles`
 * and `improvements` are reported only.
 */
export function compareScores(
  current,
  baseline,
  tolerance = COVERAGE_TOLERANCE,
) {
  const regressions = [];
  const newFiles = [];
  const improvements = [];
  const removedFiles = [];

  for (const [file, scores] of Object.entries(current)) {
    const base = baseline[file];
    if (base === undefined) {
      newFiles.push({ file, current: scores });
      continue;
    }
    const drops = [];
    let anyImprovement = false;
    const denominators = scores?.denominators ?? {};
    for (const axis of /** @type {const} */ ([
      'lines',
      'branches',
      'functions',
    ])) {
      const c = scores[axis];
      const b = base[axis];
      if (c === null || c === undefined) continue;
      if (b === null || b === undefined) continue;
      const axisTol = axisToleranceFor(denominators[axis], tolerance);
      if (c < b - axisTol)
        drops.push({
          axis,
          current: c,
          baseline: b,
          drop: b - c,
          tolerance: axisTol,
        });
      else if (c > b + axisTol) anyImprovement = true;
    }
    if (drops.length > 0) {
      regressions.push({ file, drops });
    } else if (anyImprovement) {
      improvements.push({ file });
    }
  }
  for (const file of Object.keys(baseline)) {
    if (current[file] === undefined) removedFiles.push({ file });
  }

  return { regressions, newFiles, improvements, removedFiles };
}
