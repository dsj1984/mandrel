// scripts/lib/baselines/orphan-pruner.js
//
// Story #5012 — the measurement-free remedy that makes hard-failing on a stale
// baseline row defensible.
//
// The scope gate (`check-baseline-scope.js`) blocks a PR that leaves a row
// pointing at a file it deleted. A hard gate is only fair while its remedy is
// cheap, and the existing remedy — re-run the scorer, re-derive the baseline —
// costs a full coverage run or a full-tree MI re-score for what is arithmetic
// on a row set. This pruner is that arithmetic.
//
// ## Measurement-free by contract
//
// Three prohibitions, each guarding a way the file could start lying:
//
//   1. **Never add a row.** Adding one means claiming a measurement nobody
//      took. Producing rows stays the producers' exclusive job.
//   2. **Never restamp `generatedAt`.** A fresh stamp over rows nobody
//      re-measured is precisely the failure an age check exists to catch — the
//      envelope would claim to describe today's tree on the strength of a
//      deletion. The pruner carries the original stamp through untouched.
//   3. **Never delete a row it cannot prove inert.** Only two classes qualify:
//      the file is absent from disk, or the file is no longer matched by the
//      gate's own `targetDirs` / `ignoreGlobs`. Everything else survives.
//
// ## Degrade, never guess
//
// A degraded inventory (`files: null` — unreadable `.c8rc.cjs`, absent
// `targetDirs`) means scope is unknown, not empty. Treating it as empty would
// make every row look out-of-scope and hand the pruner the whole baseline. So
// an unreadable scope config falls back to **orphan-only** pruning: the
// absent-from-disk class still resolves off the filesystem and is still safe,
// while the out-of-scope class is suspended until scope can be read again.

import fs from 'node:fs';
import path from 'node:path';

import { getKindModule } from '../../../.agents/scripts/lib/baselines/kernel.js';
import { _internals as readerInternals } from '../../../.agents/scripts/lib/baselines/reader.js';
import { writeFile } from '../../../.agents/scripts/lib/baselines/writer.js';
import { EXTRA_REASONS } from './scope-assert.js';
import {
  buildScopeInventory,
  isFileKeyed,
  SCOPE_KINDS,
} from './scope-inventory.js';

/** Every kind whose rows key on a repo-relative file path. */
export const PRUNABLE_KINDS = Object.freeze(SCOPE_KINDS.filter(isFileKeyed));

/**
 * Partition a row set into the rows to keep and the rows to drop.
 *
 * Pure given its injected `existsOnDisk` predicate. `inScope` of `null` is the
 * degraded case: only the absent-from-disk class is prunable.
 *
 * @param {{
 *   rows: Array<Record<string, unknown>>,
 *   inScope: Set<string> | null,
 *   existsOnDisk: (relPath: string) => boolean,
 * }} params
 * @returns {{ keep: Array<object>, removed: Array<{ path: string, reason: string }> }}
 */
export function planPrune({ rows, inScope, existsOnDisk } = {}) {
  const keep = [];
  const removed = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const key = row?.path;
    if (typeof key !== 'string' || key.length === 0) {
      keep.push(row);
      continue;
    }
    if (!existsOnDisk(key)) {
      removed.push({ path: key, reason: EXTRA_REASONS.ABSENT });
      continue;
    }
    if (inScope !== null && !inScope.has(key)) {
      removed.push({ path: key, reason: EXTRA_REASONS.OUT_OF_SCOPE });
      continue;
    }
    keep.push(row);
  }
  return { keep, removed };
}

/**
 * Prune one parsed envelope and recompute its `rollup` through the kind's own
 * arithmetic (`kinds/<kind>.js#rollup`), so the pruned file stays internally
 * consistent and still validates against its schema. Recomputing by a private
 * formula here would let the rollup and the rows describe different trees.
 *
 * A rollup carrying component buckets beyond `*` is refused rather than
 * recomputed: the component globs that produced those buckets live in gate
 * config this module is not handed, and emitting a `*`-only rollup would
 * silently delete them.
 *
 * @param {{
 *   kind: string,
 *   envelope: object,
 *   inventory: { files: string[] | null },
 *   existsOnDisk?: (relPath: string) => boolean,
 * }} params
 * @returns {{
 *   envelope: object | null,
 *   removed: Array<{ path: string, reason: string }>,
 *   skipped: boolean,
 *   reason: string | null,
 * }}
 */
export function pruneEnvelope({
  kind,
  envelope,
  inventory,
  existsOnDisk,
} = {}) {
  const rollupKeys = Object.keys(envelope?.rollup ?? {});
  if (rollupKeys.some((key) => key !== '*')) {
    return {
      envelope: null,
      removed: [],
      skipped: true,
      reason: `rollup carries component buckets (${rollupKeys.join(', ')}); prune them with the producer`,
    };
  }
  const inScope = inventory?.files === null ? null : new Set(inventory.files);
  const { keep, removed } = planPrune({
    rows: envelope?.rows ?? [],
    inScope,
    existsOnDisk: existsOnDisk ?? (() => true),
  });
  if (removed.length === 0) {
    return { envelope: null, removed: [], skipped: false, reason: null };
  }
  return {
    envelope: {
      ...envelope,
      // `generatedAt` is carried by the spread, deliberately unmodified.
      rollup: getKindModule(kind).rollup(keep, []),
      rows: keep,
    },
    removed,
    skipped: false,
    reason: null,
  };
}

/**
 * Read and JSON-parse a baseline file. Returns `null` when the file is absent
 * (a kind this repository does not use) and throws only on malformed JSON,
 * which is a real defect the caller should surface rather than swallow.
 *
 * @param {string} absPath
 * @param {typeof fs} fsImpl
 * @returns {object | null}
 */
function readEnvelope(absPath, fsImpl) {
  let raw;
  try {
    raw = fsImpl.readFileSync(absPath, 'utf8');
  } catch {
    return null;
  }
  return JSON.parse(raw);
}

/**
 * Prune one kind end to end: resolve its baseline path, read it, build the
 * scope inventory, plan, and (unless `check`) write.
 *
 * @param {object} params
 * @returns {object} One entry of the report's `kinds` array.
 */
function pruneKind({ kind, cwd, quality, check, fsImpl, requireFn }) {
  const absPath = readerInternals.resolveBaselinePath(kind, { cwd });
  const relPath = path.relative(cwd, absPath).split(path.sep).join('/');
  const envelope = readEnvelope(absPath, fsImpl);
  if (envelope === null) {
    return { kind, path: relPath, present: false, removed: [], written: false };
  }
  const inventory = buildScopeInventory({ kind, cwd, quality, requireFn });
  const result = pruneEnvelope({
    kind,
    envelope,
    inventory,
    existsOnDisk: (rel) => fsImpl.existsSync(path.resolve(cwd, rel)),
  });
  const base = {
    kind,
    path: relPath,
    present: true,
    degraded: inventory.degraded,
    degradedReason: inventory.degraded ? inventory.reason : null,
    skipped: result.skipped,
    skipReason: result.reason,
    removed: result.removed,
    written: false,
  };
  if (result.envelope === null || check) return base;
  writeFile(absPath, result.envelope, { fsImpl });
  return { ...base, written: true };
}

/**
 * Prune every file-keyed baseline under `cwd`.
 *
 * @param {{
 *   cwd?: string,
 *   kinds?: string[],
 *   check?: boolean,
 *   quality?: object,
 *   fsImpl?: typeof fs,
 *   requireFn?: (id: string) => object,
 * }} params
 * @returns {{ kinds: Array<object>, removedCount: number, writtenCount: number, check: boolean }}
 */
export function runPrune({
  cwd = process.cwd(),
  kinds = PRUNABLE_KINDS,
  check = false,
  quality,
  fsImpl = fs,
  requireFn,
} = {}) {
  const results = kinds.map((kind) =>
    pruneKind({ kind, cwd, quality, check, fsImpl, requireFn }),
  );
  return {
    check,
    kinds: results,
    removedCount: results.reduce((sum, r) => sum + r.removed.length, 0),
    writtenCount: results.filter((r) => r.written).length,
  };
}
