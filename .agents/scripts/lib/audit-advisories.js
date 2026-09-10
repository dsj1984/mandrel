/**
 * audit-advisories.js — run `npm audit --json` and diff advisories across refs.
 *
 * The measuring half of `audit-attribution.js` next door. That module owns the
 * verdict vocabulary and how a verdict is worded; this one owns what a verdict
 * is computed FROM.
 *
 * The comparison is **per advisory**, not per exit code. Reading only "did the
 * base audit fail too" collapses the case a busy repository meets most: a base
 * that is already red for advisory A, and a diff that adds advisory B. That
 * answered `pre-existing` — a true statement about A, and a misleading one
 * about the branch, because the author was told their diff was innocent while
 * it was carrying B. Diffing advisory ids at or above `high` reports both facts
 * separately: B introduced, A pre-existing.
 *
 * The npm spawn is injectable (`.agents/rules/test-seams.md`), so the whole
 * projection is reachable without a registry round-trip.
 */

import { spawnCapture } from './child-exec.js';

/** The levels the required SCA step fails on, so the levels attribution reads. */
const BLOCKING_SEVERITIES = new Set(['critical', 'high']);

/**
 * The stable identity of one advisory in an `npm audit --json` report.
 *
 * `source` is the advisory's own numeric id and is what makes two runs
 * comparable; the URL and title are fallbacks for a registry that omits it. A
 * `via` entry that is a bare string names another package rather than an
 * advisory and is handled by the package-level fallback in
 * {@link extractBlockingAdvisories}.
 *
 * @param {object} via
 * @returns {string|null}
 */
function advisoryIdOf(via) {
  if (via?.source !== undefined && via.source !== null) {
    return `advisory:${via.source}`;
  }
  if (typeof via?.url === 'string' && via.url.length > 0) return via.url;
  if (typeof via?.title === 'string' && via.title.length > 0) {
    return `title:${via.title}`;
  }
  return null;
}

/**
 * Project an `npm audit --json` report onto the set of advisories at or above
 * `high`, as `{ id, severity, title }` records sorted by id.
 *
 * A vulnerable package whose `via` list carries no advisory object at all — the
 * transitive case, where `via` is a list of package names — still contributes a
 * `package:<name>` entry. Dropping it would let a real blocking advisory go
 * uncounted, and an attribution that under-counts the head is one that reports
 * a genuine regression as `pre-existing`.
 *
 * @param {object|null} report — parsed `npm audit --json` output.
 * @returns {Array<{ id: string, severity: string, title: string }>}
 */
export function extractBlockingAdvisories(report) {
  const packages = report?.vulnerabilities;
  if (!packages || typeof packages !== 'object') return [];
  const found = new Map();
  for (const [name, entry] of Object.entries(packages)) {
    if (BLOCKING_SEVERITIES.has(String(entry?.severity ?? '').toLowerCase())) {
      collectPackageAdvisories(name, entry, found);
    }
  }
  return [...found.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Add one vulnerable package's blocking advisories to `found`, falling back to
 * a `package:<name>` entry when its `via` list names packages rather than
 * advisories.
 *
 * @param {string} name
 * @param {object} entry
 * @param {Map<string, object>} found
 */
function collectPackageAdvisories(name, entry, found) {
  const before = found.size;
  for (const via of Array.isArray(entry?.via) ? entry.via : []) {
    const severity = String(via?.severity ?? entry.severity).toLowerCase();
    const id = BLOCKING_SEVERITIES.has(severity) ? advisoryIdOf(via) : null;
    if (id && !found.has(id)) {
      found.set(id, { id, severity, title: via?.title ?? name });
    }
  }
  if (found.size === before) {
    found.set(`package:${name}`, {
      id: `package:${name}`,
      severity: entry.severity,
      title: name,
    });
  }
}

/**
 * Split the head's blocking advisories into the ones this diff **introduced**
 * (head minus base) and the ones the merge base already carried
 * (the intersection).
 *
 * A `null` base is the degraded read: nothing can be attributed, so neither
 * list is populated and the caller reports `unknown` rather than guessing.
 *
 * @param {{ head?: Array<object>, base?: Array<object>|null }} params
 * @returns {{ introduced: Array<object>, preExisting: Array<object> }}
 */
export function diffAdvisories({ head = [], base = null }) {
  if (!Array.isArray(base)) return { introduced: [], preExisting: [] };
  const baseIds = new Set(base.map((a) => a.id));
  return {
    introduced: head.filter((a) => !baseIds.has(a.id)),
    preExisting: head.filter((a) => baseIds.has(a.id)),
  };
}

/**
 * Run `npm audit --json` over a dependency manifest pair and project it.
 *
 * `--package-lock-only` audits the committed lockfile without installing, so
 * the probe never touches the job's own `node_modules`: an attribution
 * mechanism that could disturb the tree it is reporting on would be a worse
 * defect than the one it explains. `--json` is what makes the two runs
 * comparable at all — the human report says which advisories exist, but only
 * as prose.
 *
 * @param {string} dir — directory holding package.json + package-lock.json.
 * @param {{ spawn?: Function }} [deps]
 * @returns {{ failed: boolean, advisories: Array<object> }}
 * @throws {Error} when npm could not evaluate the tree at all.
 */
export function auditAdvisories(dir, { spawn = spawnCapture } = {}) {
  const result = spawn(
    'npm',
    ['audit', '--json', '--audit-level=high', '--package-lock-only'],
    { cwd: dir },
  );
  const report = parseAuditJson(result?.stdout);
  // npm exits non-zero for "advisories found" and for "could not audit" alike.
  // Only a real audit verdict carries a `vulnerabilities` map; anything else is
  // a probe failure the caller must read as `unknown`.
  if (!report) {
    throw new Error(
      `npm audit could not evaluate the tree: ${String(result?.stderr ?? '').slice(0, 200)}`,
    );
  }
  const advisories = extractBlockingAdvisories(report);
  return { failed: advisories.length > 0, advisories };
}

/**
 * Parse `npm audit --json` stdout, returning `null` for anything that is not a
 * real audit report. Never throws: a probe that crashed on its own output would
 * be the second failure mode this module exists to avoid.
 *
 * @param {unknown} stdout
 * @returns {object|null}
 */
function parseAuditJson(stdout) {
  try {
    const parsed = JSON.parse(String(stdout ?? ''));
    return parsed?.vulnerabilities ? parsed : null;
  } catch (_) {
    return null;
  }
}

/**
 * Render the per-advisory detail lines that follow the verdict.
 *
 * Named lists, not counts: "3 introduced" sends the reader back to the raw
 * audit output, which is the trip attribution exists to save.
 *
 * @param {{ introduced?: Array<object>, preExisting?: Array<object> }} input
 * @returns {string[]}
 */
export function renderAdvisoryDetail({ introduced = [], preExisting = [] }) {
  const list = (advisories) =>
    advisories.map((a) => `${a.id} (${a.severity})`).join(', ');
  const lines = [];
  if (introduced.length > 0) {
    lines.push(
      `Introduced by this diff (${introduced.length}): ${list(introduced)}.`,
    );
  }
  if (preExisting.length > 0) {
    lines.push(
      `Already on the merge base (${preExisting.length}): ${list(preExisting)}. Those are not this branch's to fix.`,
    );
  }
  return lines;
}
