/**
 * lib/mutation/baseline-snapshot.js — Read/write the mutation baseline file
 * consumed by the story-close mutation gate (Story #1736, Epic #1720).
 *
 * The baseline file lives at the path configured by
 * `delivery.quality.gates.mutation.baselinePath` (default
 * `baselines/mutation.json`) and conforms to:
 *
 *   {
 *     "generatedAt": "<ISO-8601 timestamp>",
 *     "tolerancePct": <number, mutation-score percent points>,
 *     "workspaces": {
 *       "*": <number, mutation-score percent points 0–100>,
 *       "<workspace-name>": <number>
 *     }
 *   }
 *
 * The `"*"` catch-all key handles single-workspace consumers; real
 * workspace names handle monorepo consumers. Generic applier code reads
 * `workspaces[name] ?? workspaces['*']`.
 *
 * `tolerancePct` carries the per-workspace mutation-score drop tolerance
 * in percent points (matches the `delivery.quality.gates.mutation.tolerance`
 * resolver default of 0). When a workspace's measured score is below
 * `baseline - tolerancePct`, the gate fails.
 *
 * This module mirrors the dependency-injection style used by
 * `lib/baseline-snapshot.js`: the fs surface and the clock are injected so
 * unit tests never touch real files. The two writer paths
 * (`readBaseline`, `writeBaseline`) are split because the typical caller
 * sequence is read-then-merge-then-write — for instance,
 * `update-mutation-baseline.js` reads the prior baseline to preserve the
 * configured `tolerancePct` if the Stryker run does not override it.
 */

import fs from 'node:fs';
import path from 'node:path';

/**
 * Default tolerance in percent points. Matches the framework-default
 * tolerance value resolved from `delivery.quality.gates.mutation.tolerance`
 * (`{ kind: 'absolute', value: 0 }`). A drop of 0% pts means any
 * regression below the recorded baseline trips the gate.
 */
export const DEFAULT_TOLERANCE_PCT = 0;

/**
 * Default baseline file path, relative to the repo root. Mirrors the
 * resolver default in `lib/config/quality.js`.
 */
export const DEFAULT_BASELINE_PATH = 'baselines/mutation.json';

/**
 * Read the mutation baseline at `baselinePath`. Returns `null` when the
 * file does not exist so the caller can distinguish "no baseline yet"
 * (the gate self-skips with an explanatory line) from a parse error.
 *
 * Throws when the file exists but is malformed (invalid JSON, missing
 * required keys, wrong types) — silent corruption must not relax the gate.
 *
 * @param {string} baselinePath  Absolute or cwd-relative path.
 * @param {{ cwd?: string, fsImpl?: { existsSync: typeof fs.existsSync, readFileSync: typeof fs.readFileSync } }} [opts]
 * @returns {{ generatedAt: string, tolerancePct: number, workspaces: Record<string, number> } | null}
 */
export function readBaseline(baselinePath, opts = {}) {
  const cwd = opts.cwd ?? process.cwd();
  const fsImpl = opts.fsImpl ?? fs;
  const abs = path.isAbsolute(baselinePath)
    ? baselinePath
    : path.resolve(cwd, baselinePath);
  if (!fsImpl.existsSync(abs)) return null;
  const raw = fsImpl.readFileSync(abs, 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `[mutation/baseline-snapshot] failed to parse ${baselinePath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return validateBaseline(parsed, baselinePath);
}

/**
 * Atomically rewrite the mutation baseline at `baselinePath` from
 * `payload`. "Atomic" here means write-temp-then-rename, so a SIGKILL
 * mid-write never leaves a half-written baseline file on disk.
 *
 * The on-disk shape is canonicalised: `workspaces` keys are sorted
 * alphabetically (with `"*"` always first) and the file ends with a
 * trailing newline. This produces a byte-stable serialisation, which
 * the `update-mutation-baseline.js` entry-point relies on to detect
 * "no change" runs (skip the baseline-refresh commit when re-running
 * Stryker produces an identical baseline).
 *
 * @param {string} baselinePath
 * @param {{ generatedAt?: string, tolerancePct?: number, workspaces: Record<string, number> }} payload
 * @param {{ cwd?: string, fsImpl?: object, clock?: () => Date }} [opts]
 * @returns {{ path: string, bytes: string, didChange: boolean }}
 */
export function writeBaseline(baselinePath, payload, opts = {}) {
  const cwd = opts.cwd ?? process.cwd();
  const fsImpl = opts.fsImpl ?? fs;
  const clock = opts.clock ?? (() => new Date());
  const abs = path.isAbsolute(baselinePath)
    ? baselinePath
    : path.resolve(cwd, baselinePath);
  const generatedAt = payload.generatedAt ?? clock().toISOString();
  const tolerancePct = Number.isFinite(payload.tolerancePct)
    ? payload.tolerancePct
    : DEFAULT_TOLERANCE_PCT;
  if (
    !payload ||
    typeof payload.workspaces !== 'object' ||
    payload.workspaces === null
  ) {
    throw new TypeError(
      '[mutation/baseline-snapshot] writeBaseline: payload.workspaces must be an object',
    );
  }
  const workspaces = canonicaliseWorkspaces(payload.workspaces);
  const envelope = { generatedAt, tolerancePct, workspaces };
  const bytes = `${JSON.stringify(envelope, null, 2)}\n`;
  let prior = null;
  if (fsImpl.existsSync(abs)) {
    try {
      prior = fsImpl.readFileSync(abs, 'utf8');
    } catch {
      prior = null;
    }
  }
  if (prior === bytes) {
    return { path: abs, bytes, didChange: false };
  }
  fsImpl.mkdirSync?.(path.dirname(abs), { recursive: true });
  // Atomic write: write to a sibling temp file then rename. `renameSync`
  // is atomic on POSIX and best-effort on Windows (which is good enough —
  // the previous file is never half-overwritten).
  const tmp = `${abs}.tmp-${process.pid}`;
  fsImpl.writeFileSync(tmp, bytes);
  try {
    fsImpl.renameSync?.(tmp, abs);
  } catch {
    // `fs` shims in tests may not implement renameSync — fall back to a
    // direct write + best-effort unlink so the in-memory store still
    // converges to the right state.
    fsImpl.writeFileSync(abs, bytes);
    try {
      fsImpl.unlinkSync?.(tmp);
    } catch {
      /* ignore */
    }
  }
  return { path: abs, bytes, didChange: true };
}

/**
 * Validate that `parsed` matches the baseline envelope contract. Returns
 * the parsed object unchanged when it conforms; throws otherwise.
 *
 * Exposed for unit testing the validator independently of fs I/O.
 *
 * @param {unknown} parsed
 * @param {string} sourceLabel
 * @returns {{ generatedAt: string, tolerancePct: number, workspaces: Record<string, number> }}
 */
export function validateBaseline(parsed, sourceLabel = '<input>') {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(
      `[mutation/baseline-snapshot] ${sourceLabel}: expected an object, got ${Array.isArray(parsed) ? 'array' : typeof parsed}`,
    );
  }
  const { generatedAt, tolerancePct, workspaces } =
    /** @type {Record<string, unknown>} */ (parsed);
  if (typeof generatedAt !== 'string' || generatedAt.length === 0) {
    throw new Error(
      `[mutation/baseline-snapshot] ${sourceLabel}: 'generatedAt' must be a non-empty string`,
    );
  }
  if (
    !Number.isFinite(tolerancePct) ||
    /** @type {number} */ (tolerancePct) < 0
  ) {
    throw new Error(
      `[mutation/baseline-snapshot] ${sourceLabel}: 'tolerancePct' must be a non-negative number`,
    );
  }
  if (
    !workspaces ||
    typeof workspaces !== 'object' ||
    Array.isArray(workspaces)
  ) {
    throw new Error(
      `[mutation/baseline-snapshot] ${sourceLabel}: 'workspaces' must be an object`,
    );
  }
  for (const [name, score] of Object.entries(workspaces)) {
    if (typeof name !== 'string' || name.length === 0) {
      throw new Error(
        `[mutation/baseline-snapshot] ${sourceLabel}: workspace name must be a non-empty string`,
      );
    }
    if (
      !Number.isFinite(score) ||
      /** @type {number} */ (score) < 0 ||
      /** @type {number} */ (score) > 100
    ) {
      throw new Error(
        `[mutation/baseline-snapshot] ${sourceLabel}: workspace "${name}" score must be a number in [0, 100], got ${JSON.stringify(score)}`,
      );
    }
  }
  return /** @type {{ generatedAt: string, tolerancePct: number, workspaces: Record<string, number> }} */ (
    parsed
  );
}

/**
 * Sort `workspaces` keys deterministically so the on-disk serialisation
 * is byte-stable. The `"*"` catch-all key is pinned to the first slot;
 * the remaining keys sort alphabetically.
 *
 * @param {Record<string, number>} workspaces
 * @returns {Record<string, number>}
 */
function canonicaliseWorkspaces(workspaces) {
  const keys = Object.keys(workspaces);
  const sorted = keys.slice().sort((a, b) => {
    if (a === '*') return -1;
    if (b === '*') return 1;
    return a.localeCompare(b);
  });
  const out = /** @type {Record<string, number>} */ ({});
  for (const k of sorted) {
    out[k] = workspaces[k];
  }
  return out;
}
