/**
 * writer.js — shared baseline writer (Story #1891, Epic #1786).
 *
 * Every legacy baseline-refresh script (`update-crap-baseline.js`,
 * `update-maintainability-baseline.js`, `lib/coverage-baseline.js`,
 * the auto-refresh evaluator, now inside `auto-refresh-runner.js`) used to assemble its own envelope and
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
import { deepEqual } from '../json-utils.js';
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
 * Story #1974 (s-diff-scoped-writes) added the optional `scope` parameter.
 * When `scope` is present *and* `prior` is supplied, the writer calls the
 * per-kind `mergeRows(prior, projected, scope)` filter **after** projection
 * but **before** `applyEpsilon`. The composition is intentional: scope-
 * filter first (preserve out-of-scope prior rows verbatim), then stabilise
 * the in-scope rows against the same prior under epsilon. The merged result
 * is sorted, rolled up, and serialised exactly as before. When `scope` is
 * absent (or `prior` is absent), behaviour is unchanged from the pre-#1974
 * contract — also regression-fail-safe.
 *
 * `prior` MUST be an array of rows already in canonical (per-kind
 * `projectRow`) shape — the on-disk baseline format is canonical
 * end-to-end, and the writer no longer re-projects prior rows on entry.
 *
 * Story #2135 (Task #2146) added the structural-equality short-circuit on
 * top of `prior`. When a `prior` envelope (or `priorEnvelope`) is supplied
 * and the projected `rows + rollup` deep-equal the prior's `rows + rollup`,
 * the writer returns the prior envelope unchanged — same `generatedAt`,
 * same kernelVersion, same byte payload. Without this guard every
 * auto-refresh that ran on a no-op Story would stamp a fresh
 * `generatedAt` and surface a spurious one-line diff. The short-circuit
 * is the semantic replacement for the legacy byte-equality compare that
 * lived in `baseline-snapshot.js`.
 *
 * @param {{
 *   kind: string,
 *   rows: Array<object>,
 *   components?: Array<object>,
 *   kernelVersion?: string,
 *   generatedAt?: string,
 *   prior?: Array<object>,
 *   priorEnvelope?: object,
 *   epsilon?: number,
 *   scope?: {mode: 'full'|'diff', files: Set<string>|Iterable<string>}|null,
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
  priorEnvelope,
  epsilon,
  scope,
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

  const merged = scopeMergeRows(mod, projected, prior, scope);
  const stabilised = stabiliseRows(mod, merged, prior, epsilon);

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

  // Story #2135 / Task #2146 — structural-equality short-circuit. When the
  // caller supplies a `priorEnvelope` (or, for backwards-compatibility, the
  // bare `prior` array is itself a full envelope object), and the projected
  // rows + rollup deep-equal what's on the prior, return the prior envelope
  // unchanged. This is the semantic replacement for the byte-equality
  // compare in `baseline-snapshot.js` and is what makes a no-op auto-refresh
  // produce a zero-byte baseline diff.
  const priorEnv = resolvePriorEnvelope(priorEnvelope, prior);
  if (
    priorEnv &&
    deepEqual(sortedRows, priorEnv.rows) &&
    deepEqual(rollup, priorEnv.rollup)
  ) {
    // Re-validate defensively before returning so a caller cannot smuggle
    // an invalid envelope through the short-circuit.
    assertEnvelope(priorEnv);
    return priorEnv;
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
 * Resolve the prior envelope used by the structural-equality short-circuit.
 * Accepts either an explicit `priorEnvelope` (preferred) or, for backwards
 * compatibility, recognises when `prior` is itself a full envelope object
 * carrying `rows` + `rollup` rather than a bare rows array. Returns null
 * when neither yields a usable envelope — the short-circuit is opt-in by
 * design.
 */
function resolvePriorEnvelope(priorEnvelope, prior) {
  if (
    priorEnvelope &&
    typeof priorEnvelope === 'object' &&
    !Array.isArray(priorEnvelope) &&
    Array.isArray(priorEnvelope.rows) &&
    priorEnvelope.rollup &&
    typeof priorEnvelope.rollup === 'object'
  ) {
    return priorEnvelope;
  }
  if (
    prior &&
    typeof prior === 'object' &&
    !Array.isArray(prior) &&
    Array.isArray(prior.rows) &&
    prior.rollup &&
    typeof prior.rollup === 'object'
  ) {
    return prior;
  }
  return null;
}

/**
 * Serialise an envelope to `absPath`. Deterministic: two-space indent,
 * trailing newline, sorted keys for the top-level envelope keys (rows are
 * already sorted by the per-kind module's `sortRows`). Atomic: writes to
 * `<absPath>.tmp` then `rename`s onto the destination so a crash mid-write
 * never leaves a half-flushed envelope on disk.
 *
 * Story #2135 / Task #2146 — the optional `fsImpl` seam lets tests inject
 * a virtual filesystem (or an in-memory recorder) the way the legacy
 * saver helpers allowed. Production callers omit it and fall through to
 * `node:fs`. The seam covers `mkdirSync`, `writeFileSync`, and
 * `renameSync` — the three calls this function actually makes — so a mock
 * that exposes a subset of `fs` works without leaking real disk I/O.
 *
 * Backwards-compatible: two-argument callers (`writeFile(abs, env)`)
 * continue to work unchanged.
 *
 * @param {string} absPath
 * @param {object} envelope
 * @param {{ fsImpl?: { mkdirSync: typeof fs.mkdirSync, writeFileSync: typeof fs.writeFileSync, renameSync: typeof fs.renameSync } }} [opts]
 * @returns {string}  The absolute path written.
 */
export function writeFile(absPath, envelope, opts = {}) {
  if (typeof absPath !== 'string' || !path.isAbsolute(absPath)) {
    throw new TypeError(
      `writer.writeFile: absPath must be an absolute path (got ${JSON.stringify(absPath)})`,
    );
  }
  // Re-validate at the seam — a caller might mutate the envelope between
  // `write()` and `writeFile()`.
  assertEnvelope(envelope);

  const fsImpl = opts?.fsImpl ? opts.fsImpl : fs;

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
  fsImpl.mkdirSync(path.dirname(absPath), { recursive: true });
  fsImpl.writeFileSync(tmpPath, `${JSON.stringify(canonical, null, 2)}\n`);
  fsImpl.renameSync(tmpPath, absPath);
  return absPath;
}

/**
 * Story #1974 — s-diff-scoped-writes scope-merge dispatch. When `scope` is
 * present, defer to the per-kind `mergeRows(prior, projected, scope)` to
 * preserve out-of-scope prior rows verbatim. Returns `projected` unchanged
 * when `scope` is omitted, when the kind doesn't ship the merger
 * (forward-compatible), or when `prior` is absent (nothing to preserve).
 */
function scopeMergeRows(mod, projected, prior, scope) {
  if (scope === undefined || scope === null) return projected;
  if (typeof mod.mergeRows !== 'function') return projected;
  // mergeRows treats null/undefined/empty prior as "no preservation needed"
  // and returns projected verbatim — that branch is covered upstream and
  // here for symmetry.
  return mod.mergeRows(prior ?? [], projected, scope);
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
