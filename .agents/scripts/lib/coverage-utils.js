import fs from 'node:fs';

const COVERAGE_INDEX = Symbol('coverage-utils.coverage-index');
const ENTRY_INDEX = Symbol('coverage-utils.entry-index');

/**
 * Never throws; `null` for any missing or unusable artifact.
 *
 * @param {string} coveragePath
 * @returns {object|null}
 */
export function loadCoverage(coveragePath) {
  try {
    if (!coveragePath || !fs.existsSync(coveragePath)) return null;
    const raw = fs.readFileSync(coveragePath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function normalizeSep(p) {
  return String(p).replace(/\\/g, '/');
}

function stripLeadingDotSlash(p) {
  return p.replace(/^\.\/+/, '').replace(/^\/+/, '');
}

/**
 * Entries keyed by POSIX-normalized path.
 *
 * @param {object|null} map
 * @returns {{map: object|null, byNormalizedSuffix: Map<string, object>}}
 */
export function buildCoverageIndex(map) {
  const byNormalizedSuffix = new Map();
  if (map && typeof map === 'object' && !Array.isArray(map)) {
    for (const key of Object.keys(map)) {
      byNormalizedSuffix.set(normalizeSep(key), map[key]);
    }
  }
  return { map, byNormalizedSuffix };
}

function getCoverageIndex(map) {
  if (!map || typeof map !== 'object' || Array.isArray(map)) return null;
  const cached = map[COVERAGE_INDEX];
  if (cached) return cached;
  const idx = buildCoverageIndex(map);
  Object.defineProperty(map, COVERAGE_INDEX, {
    value: idx,
    enumerable: false,
    configurable: true,
    writable: false,
  });
  return idx;
}

/**
 * Match a repo-relative path to an absolute key by exact or `/`-bounded
 * suffix. An ambiguous suffix returns null rather than scoring the wrong file.
 */
function findFileEntry(map, relPath) {
  if (!map || !relPath) return null;
  const suffix = stripLeadingDotSlash(normalizeSep(relPath));
  if (!suffix) return null;
  const idx = getCoverageIndex(map);
  if (!idx) return null;
  const direct = idx.byNormalizedSuffix.get(suffix);
  if (direct !== undefined) return direct ?? null;
  const needle = `/${suffix}`;
  let match = null;
  for (const [norm, entry] of idx.byNormalizedSuffix) {
    if (!norm.endsWith(needle)) continue;
    if (match !== null) return null; // ambiguous suffix — refuse to guess
    match = entry ?? null;
  }
  return match;
}

export { findFileEntry as findCoverageEntry };

/**
 * @param {object|null} map
 * @param {string} relPath
 * @returns {boolean}
 */
export function hasCoverageFor(map, relPath) {
  return findFileEntry(map, relPath) !== null;
}

/**
 * Per-entry index making a method lookup `O(method-line-span)`. Functions are
 * keyed by both `decl` and `loc` start lines (producers differ).
 *
 * @param {object|null} entry One inner value from a `coverage-final.json` map.
 */
export function buildEntryIndex(entry) {
  const fnByStartLine = new Map();
  const fnLocByStartLine = new Map();
  const fnRanges = [];
  const statementsByLine = new Map();
  if (!entry || typeof entry !== 'object') {
    return { fnByStartLine, fnLocByStartLine, fnRanges, statementsByLine };
  }
  const fnMap = entry.fnMap ?? {};
  const statementMap = entry.statementMap ?? {};
  const statementHits = entry.s ?? {};

  for (const fnId of Object.keys(fnMap)) {
    const f = fnMap[fnId];
    const declLine = f?.decl?.start?.line;
    const locLine = f?.loc?.start?.line;
    const fnStart = locLine ?? declLine ?? null;
    const fnEnd = f?.loc?.end?.line ?? null;
    const loc = { fnStart, fnEnd };
    if (typeof declLine === 'number' && !fnByStartLine.has(declLine)) {
      fnByStartLine.set(declLine, f);
      fnLocByStartLine.set(declLine, loc);
    }
    if (typeof locLine === 'number' && !fnByStartLine.has(locLine)) {
      fnByStartLine.set(locLine, f);
      fnLocByStartLine.set(locLine, loc);
    }
    if (fnStart !== null && fnEnd !== null) {
      fnRanges.push({
        fnStart,
        fnEnd,
        declLine: typeof declLine === 'number' ? declLine : fnStart,
      });
    }
  }

  for (const stmtId of Object.keys(statementMap)) {
    const stmt = statementMap[stmtId];
    const sLine = stmt?.start?.line;
    if (typeof sLine !== 'number') continue;
    let bucket = statementsByLine.get(sLine);
    if (!bucket) {
      bucket = { total: 0, covered: 0 };
      statementsByLine.set(sLine, bucket);
    }
    bucket.total += 1;
    if ((statementHits[stmtId] ?? 0) > 0) bucket.covered += 1;
  }

  return { fnByStartLine, fnLocByStartLine, fnRanges, statementsByLine };
}

/**
 * escomplex and istanbul can disagree by one line on a function's start
 * (decorator, leading `export`, multi-line params); wider would claim a
 * neighbour.
 */
const DECL_MATCH_WINDOW = 1;

/**
 * Exact start line, else innermost containing range, else nearest `decl`
 * within `DECL_MATCH_WINDOW`; `null` means "no data", not "untested".
 *
 * @param {{fnByStartLine: Map, fnLocByStartLine: Map, fnRanges: Array}} idx
 * @param {number} startLine
 * @returns {{fnStart: number, fnEnd: number}|null}
 */
function resolveFnRangeForLine(idx, startLine) {
  if (typeof startLine !== 'number') return null;
  if (idx.fnByStartLine.has(startLine)) {
    const loc = idx.fnLocByStartLine.get(startLine);
    if (loc && loc.fnStart !== null && loc.fnEnd !== null) return loc;
  }
  const ranges = idx.fnRanges ?? [];
  let innermost = null;
  let innermostSpan = Number.POSITIVE_INFINITY;
  for (const range of ranges) {
    if (startLine < range.fnStart || startLine > range.fnEnd) continue;
    const span = range.fnEnd - range.fnStart;
    if (span < innermostSpan) {
      innermostSpan = span;
      innermost = range;
    }
  }
  if (innermost) return { fnStart: innermost.fnStart, fnEnd: innermost.fnEnd };

  let nearest = null;
  let nearestDist = Number.POSITIVE_INFINITY;
  for (const range of ranges) {
    const dist = Math.abs(range.declLine - startLine);
    if (dist > DECL_MATCH_WINDOW) continue;
    if (dist < nearestDist) {
      nearestDist = dist;
      nearest = range;
    }
  }
  if (nearest) return { fnStart: nearest.fnStart, fnEnd: nearest.fnEnd };
  return null;
}

function getEntryIndex(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const cached = entry[ENTRY_INDEX];
  if (cached) return cached;
  const idx = buildEntryIndex(entry);
  Object.defineProperty(entry, ENTRY_INDEX, {
    value: idx,
    enumerable: false,
    configurable: true,
    writable: false,
  });
  return idx;
}

/**
 * Executed fraction of statements in the method's range (0 for an empty
 * range, `null` for no data). `startLine` MUST be in original-source
 * coordinates. The entry index is cached on the entry.
 *
 * @param {object|null} entry One inner value from a `coverage-final.json` map.
 * @param {number} startLine The method's start line, in entry coordinates.
 * @returns {number|null}
 */
export function coverageForMethodInEntry(entry, startLine) {
  if (!entry || typeof entry !== 'object') return null;
  const idx = getEntryIndex(entry);
  const range = resolveFnRangeForLine(idx, startLine);
  if (!range) return null;
  const { fnStart, fnEnd } = range;

  let total = 0;
  let covered = 0;
  for (let line = fnStart; line <= fnEnd; line += 1) {
    const bucket = idx.statementsByLine.get(line);
    if (!bucket) continue;
    total += bucket.total;
    covered += bucket.covered;
  }

  if (total === 0) return 0;
  return covered / total;
}

/**
 * @param {object|null} map Parsed `coverage-final.json`.
 * @param {string} relPath Repo-relative path of the source file.
 * @param {number} startLine The method's start line, in entry coordinates.
 * @returns {number|null} Coverage in [0, 1], or null when the file or method
 *   is absent.
 */
export function coverageByMethod(map, relPath, startLine) {
  const entry = findFileEntry(map, relPath);
  if (!entry) return null;
  return coverageForMethodInEntry(entry, startLine);
}
