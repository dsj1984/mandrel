/**
 * writer.js — shared baseline writer (Story #1891, Epic #1786).
 *
 * Every legacy baseline-refresh script (`update-crap-baseline.js`,
 * `update-maintainability-baseline.js`, `lib/coverage-baseline.js`,
 * `lib/auto-refresh-baselines.js`) used to assemble its own envelope and
 * call `fs.writeFileSync`. That meant the path canonicalisation, rollup
 * math, kernel-version stamping, and JSON-serialisation conventions were
 * duplicated five-ish times, each with subtly different rules. The
 * worktree-prefix bug that prompted Story #1891 is the proof: each
 * refresh path had to remember to strip `.worktrees/<workspace>/` on its
 * own, and the maintainability path forgot.
 *
 * `write({ kind, rows, components, kernelVersion?, generatedAt? })` is
 * the single funnel:
 *
 *   1. Look up the per-kind module via the kernel registry. The module
 *      declares the `keyField`, `projectRow`, `sortRows`, `rollup`, and
 *      `kernelVersion()` functions.
 *   2. Run every row through `projectRow` — that's where the path is
 *      canonicalised via `path-canon.canonicalise()`. After projection,
 *      the writer asserts every key field is already canonical
 *      (`path-canon.assertCanonical()`), refusing to silently rewrite
 *      identity.
 *   3. Sort the rows for deterministic on-disk diffs.
 *   4. Compute the per-component rollup (always including `*`).
 *   5. Stamp the envelope via `buildEnvelope` — `$schema`, `kernelVersion`,
 *      `generatedAt`.
 *   6. Validate the envelope via `assertEnvelope` (AJV against the per-kind
 *      schema).
 *   7. Return the envelope object. Callers serialise via `writeFile()`
 *      (separate seam so tests can round-trip without touching disk).
 *
 * `writeFile(absPath, envelope)` is the serialise + flush seam. It
 * stringifies the envelope with two-space indent, appends a trailing
 * newline, creates the parent directory, and writes atomically (write to
 * `<path>.tmp` then `rename` — `rename` is atomic on every platform we
 * support).
 *
 * @module lib/baselines/writer
 */

import fs from 'node:fs';
import path from 'node:path';
import { assertEnvelope, buildEnvelope } from './envelope.js';
import { currentKernelVersion, getKindModule } from './kernel.js';
import { assertCanonical } from './path-canon.js';

/**
 * Assemble + validate a baseline envelope. Returns the envelope object
 * (no disk I/O). Callers feed the result into `writeFile()` when they're
 * ready to persist.
 *
 * Story #1964 (s-stability-epsilon) added the optional `prior` and
 * `epsilon` parameters. When both are present, the writer calls the
 * per-kind `applyEpsilon(prior, regenerated, epsilon)` stabilizer
 * **after** projection but **before** sort/rollup/serialise. Sub-epsilon
 * row deltas resolve to the prior bytes, so env variance never rewrites
 * the on-disk envelope. When either is absent (`undefined`), behaviour is
 * unchanged from the pre-#1964 contract — this is regression-fail-safe by
 * design so existing call sites stay untouched.
 *
 * `prior` MUST be an array of already-canonical rows (typically the
 * `rows[]` from the previous envelope on disk). Passing raw, un-projected
 * rows is a programming error: the lookup matches by the canonical key
 * field, so non-canonical paths simply miss the prior map and fall
 * through to the regenerated row.
 *
 * @param {{
 *   kind: string,
 *   rows: Array<object>,
 *   components?: Array<object>,
 *   kernelVersion?: string,
 *   generatedAt?: string,
 *   prior?: Array<object>,
 *   epsilon?: number,
 * }} params
 * @returns {object}
 */
export function write({
  kind,
  rows,
  components,
  kernelVersion,
  generatedAt,
  prior,
  epsilon,
} = {}) {
  if (typeof kind !== 'string' || kind.length === 0) {
    throw new TypeError('writer.write: kind is required');
  }
  if (!Array.isArray(rows)) {
    throw new TypeError('writer.write: rows must be an array');
  }

  const mod = getKindModule(kind);
  const projected = rows.map((row, idx) => {
    try {
      return mod.projectRow(row);
    } catch (err) {
      throw new Error(
        `writer.write: failed to project ${kind} row at index ${idx}: ${err.message}`,
      );
    }
  });

  // Defensive: assert every key field on the projected rows is canonical.
  // The per-kind `projectRow` already funnels paths through `canonicalise`,
  // but the assertion catches a future per-kind module that forgets — and
  // catches absolute paths in inputs that the canonicaliser would also
  // throw on (we surface a writer-scoped error pointing at the row).
  if (mod.keyField === 'path') {
    projected.forEach((row, idx) => {
      try {
        assertCanonical(row.path);
      } catch (err) {
        throw new Error(
          `writer.write: ${kind} row at index ${idx} has a non-canonical path: ${err.message}`,
        );
      }
    });
  }

  const stabilised = stabiliseRows(mod, projected, prior, epsilon);

  const sortedRows = mod.sortRows(stabilised);
  const rollup = mod.rollup(sortedRows, components ?? []);

  // The rollup() implementations always seed `*` from `aggregate()`, but
  // the AC pins this explicitly: the envelope ALWAYS carries `*` even
  // when `components` is undefined or empty. Belt-and-braces.
  if (!Object.hasOwn(rollup, '*')) {
    throw new Error(
      `writer.write: ${kind} rollup is missing the required "*" key`,
    );
  }

  const envelope = buildEnvelope({
    kind,
    rows: sortedRows,
    rollup,
    kernelVersion: kernelVersion ?? currentKernelVersion(kind),
    generatedAt,
  });
  assertEnvelope(envelope);
  return envelope;
}

/**
 * Serialise an envelope to `absPath`. Deterministic: two-space indent,
 * trailing newline, sorted keys for the top-level envelope keys (rows are
 * already sorted by the per-kind module's `sortRows`). Atomic: writes to
 * `<absPath>.tmp` then `rename`s onto the destination so a crash mid-write
 * never leaves a half-flushed envelope on disk.
 *
 * @param {string} absPath
 * @param {object} envelope
 * @returns {string}  The absolute path written.
 */
export function writeFile(absPath, envelope) {
  if (typeof absPath !== 'string' || !path.isAbsolute(absPath)) {
    throw new TypeError(
      `writer.writeFile: absPath must be an absolute path (got ${JSON.stringify(absPath)})`,
    );
  }
  // Re-validate at the seam — a caller might mutate the envelope between
  // `write()` and `writeFile()`.
  assertEnvelope(envelope);

  // Canonical key order on the top-level envelope keeps diffs stable
  // across runs and platforms. Per-kind row keys retain their natural
  // declaration order; the row sort is done by `sortRows()`.
  const canonical = {
    $schema: envelope.$schema,
    kernelVersion: envelope.kernelVersion,
    generatedAt: envelope.generatedAt,
    rollup: envelope.rollup,
    rows: envelope.rows,
  };

  const tmpPath = `${absPath}.tmp`;
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(tmpPath, `${JSON.stringify(canonical, null, 2)}\n`);
  fs.renameSync(tmpPath, absPath);
  return absPath;
}

/**
 * Story #1964 — s-stability-epsilon stabilizer dispatch. When both
 * `prior` and `epsilon` are present, fold sub-epsilon row deltas back to
 * the prior bytes via the per-kind `applyEpsilon`. Returns `projected`
 * unchanged when either is omitted, or when the kind doesn't ship the
 * stabilizer (forward-compatible).
 */
function stabiliseRows(mod, projected, prior, epsilon) {
  if (prior === undefined || epsilon === undefined) return projected;
  if (!Array.isArray(prior)) {
    throw new TypeError('writer.write: prior must be an array when provided');
  }
  if (typeof epsilon !== 'number' || !Number.isFinite(epsilon) || epsilon < 0) {
    throw new TypeError(
      `writer.write: epsilon must be a non-negative finite number (got ${JSON.stringify(epsilon)})`,
    );
  }
  return typeof mod.applyEpsilon === 'function'
    ? mod.applyEpsilon(prior, projected, epsilon)
    : projected;
}
