/**
 * ci-deferral.js — close gates CI owns: the capture under
 * `coverage.suiteOfRecord: "ci"` and any gate marked `ciDeferred` after a
 * conflict-free base merge, settled before the runner spawns anything.
 */

import { COVERAGE_DEFERRED_REASONS } from '../coverage-deferral.js';
import { CI_RATCHET_UNDECLARED_HINT } from './gates.js';

/**
 * A gate CI owns: deferred without spawning, or — a `suiteOfRecordCi` capture
 * with no ratchet check — failed with a hint naming both keys. Mutates
 * `deferred` / `failed`.
 *
 * @param {import('./gates.js').Gate} gate
 * @param {{ deferred: object[], failed: object[], log: (m: string) => void, spawnCwd: string }} acc
 * @returns {'deferred'|'stop'|null} `null` for any other gate.
 */
export function presetCiDeferral(gate, acc) {
  if (gate.ciDeferred) return deferToChecks(gate, acc);
  return presetSuiteOfRecord(gate, acc);
}

/** A `ciDeferred` gate: settled deferred, naming the checks that own it. */
function deferToChecks(gate, { deferred, log, spawnCwd }) {
  const { reason, checks } = gate.ciDeferred;
  log(
    `[close-validation] ⏭ ${gate.name} deferred to CI (${reason}, checks: ${checks.join(', ')}) — nothing spawned in ${spawnCwd}`,
  );
  deferred.push({ gate, status: null, reason });
  return 'deferred';
}

/** A capture under `suiteOfRecord: "ci"`, else `null`. */
function presetSuiteOfRecord(gate, { deferred, failed, log, spawnCwd }) {
  const posture = gate.suiteOfRecordCi;
  if (!posture) return null;
  if (!posture.ciRatchetCheck) {
    log(
      `[close-validation] ✖ ${gate.name}: suiteOfRecord "ci" names no ciRatchetCheck — nothing spawned in ${spawnCwd}`,
    );
    log(`[close-validation]   hint: ${CI_RATCHET_UNDECLARED_HINT}`);
    const failedGate = { ...gate, hint: CI_RATCHET_UNDECLARED_HINT };
    failed.push({
      gate: failedGate,
      status: 1,
      cwd: spawnCwd,
      outcome: 'failed',
    });
    return 'stop';
  }
  log(
    `[close-validation] ⏭ ${gate.name} deferred to CI (suiteOfRecord: ci, ratchet check "${posture.ciRatchetCheck}") — nothing spawned in ${spawnCwd}`,
  );
  const reason = COVERAGE_DEFERRED_REASONS.suiteOfRecordCi;
  deferred.push({ gate, status: null, reason });
  return 'deferred';
}
