/**
 * Shared baseline writer, the single funnel for envelope assembly
 * (`write`: project, canonical-assert, merge, stabilise, sort, rollup, stamp,
 * validate) and serialisation (`writeFile`: atomic tmp + rename).
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
 * Assemble and validate an envelope (no I/O). With `scope`, out-of-scope
 * `prior` rows are preserved first; with `epsilon`, sub-epsilon deltas then
 * resolve to prior bytes. `prior` rows must already be canonical. When rows
 * and rollup deep-equal the prior envelope, the prior is returned unchanged
 * so a no-op refresh leaves no `generatedAt` diff.
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

  // Catches a kind module whose `projectRow` forgets to canonicalise.
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

  if (!Object.hasOwn(rollup, '*')) {
    throw new Error(
      `writer.write: ${kind} rollup is missing the required "*" key`,
    );
  }

  const priorEnv = resolvePriorEnvelope(priorEnvelope, prior);
  if (
    priorEnv &&
    deepEqual(sortedRows, priorEnv.rows) &&
    deepEqual(rollup, priorEnv.rollup)
  ) {
    // No smuggling an invalid envelope through the short-circuit.
    assertEnvelope(priorEnv);
    return priorEnv;
  }

  const envelope = buildEnvelope({
    kind,
    rows: sortedRows,
    rollup,
    kernelVersion: kernelVersion ?? currentKernelVersion(kind),
    generatedAt,
    extras:
      typeof mod.envelopeExtras === 'function' ? mod.envelopeExtras() : null,
  });
  assertEnvelope(envelope);
  return envelope;
}

/** `priorEnvelope`, else `prior` when it is a whole envelope, else null. */
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
 * Serialise deterministically (fixed top-level key order, two-space indent,
 * trailing newline) and atomically (tmp + rename).
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
  // The caller may have mutated the envelope since `write()`.
  assertEnvelope(envelope);

  const fsImpl = opts?.fsImpl ? opts.fsImpl : fs;

  // A kind's envelope stamp reaches disk only if named here — add every new
  // `envelopeExtras()` key. Unset stamps are undefined and JSON omits them.
  const canonical = {
    $schema: envelope.$schema,
    kernelVersion: envelope.kernelVersion,
    generatedAt: envelope.generatedAt,
    scoringSemantics: envelope.scoringSemantics,
    tsTranspilerVersion: envelope.tsTranspilerVersion,
    provenanceStamped: envelope.provenanceStamped,
    rollup: envelope.rollup,
    rows: envelope.rows,
  };

  const tmpPath = `${absPath}.tmp`;
  fsImpl.mkdirSync(path.dirname(absPath), { recursive: true });
  fsImpl.writeFileSync(tmpPath, `${JSON.stringify(canonical, null, 2)}\n`);
  fsImpl.renameSync(tmpPath, absPath);
  return absPath;
}

function scopeMergeRows(mod, projected, prior, scope) {
  if (scope === undefined || scope === null) return projected;
  if (typeof mod.mergeRows !== 'function') return projected;
  return mod.mergeRows(prior ?? [], projected, scope);
}

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
