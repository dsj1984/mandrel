/**
 * ci-deferral.js — close's coverage capture under `coverage.suiteOfRecord:
 * "ci"`: settled before the serial runner spawns anything.
 */

import { COVERAGE_DEFERRED_REASONS } from '../coverage-deferral.js';
import { CI_RATCHET_UNDECLARED_HINT } from './gates.js';

/**
 * A capture CI owns: deferred without spawning, or failed with a hint naming
 * both keys when no ratchet check is declared. Mutates `deferred` / `failed`.
 *
 * @param {import('./gates.js').Gate} gate
 * @param {{ deferred: object[], failed: object[], log: (m: string) => void, spawnCwd: string }} acc
 * @returns {'deferred'|'stop'|null} `null` for any other gate.
 */
export function presetCiDeferral(gate, { deferred, failed, log, spawnCwd }) {
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
