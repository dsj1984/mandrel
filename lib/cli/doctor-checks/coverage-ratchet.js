// lib/cli/doctor-checks/coverage-ratchet.js — Doctor check: coverage-ratchet.

import fs from 'node:fs';
import { readEffectiveAgentrc } from './effective-agentrc.js';

const KEY = 'delivery.quality.gates.coverage';

/** Which setting hands the coverage ratchet to CI, else `null`. */
function deferringSetting(gate) {
  if (gate.suiteOfRecord === 'ci') return `${KEY}.suiteOfRecord: "ci"`;
  if (gate.onOverBudget === 'defer-to-ci') {
    return `${KEY}.onOverBudget: "defer-to-ci"`;
  }
  return null;
}

/**
 * Fails when coverage can be deferred to CI (`suiteOfRecord: "ci"` or
 * `onOverBudget: "defer-to-ci"`) with no `ciRatchetCheck` naming the CI check
 * that ratchets it — a deferred Story would land unratcheted.
 *
 * @param {{ projectRoot?: string, cwd?: () => string, fsImpl?: { readFileSync: Function, existsSync: Function } }} [opts]
 * @returns {Promise<{ ok: boolean, detail: string, remedy?: string }>}
 */
export async function runCoverageRatchet({
  projectRoot,
  cwd,
  fsImpl = fs,
} = {}) {
  const root = projectRoot ?? (cwd ?? (() => process.cwd()))();
  // The `ci` posture is a host setting, so the local overlay counts.
  const gate =
    readEffectiveAgentrc(root, fsImpl)?.delivery?.quality?.gates?.coverage ??
    {};
  const setting = deferringSetting(gate);
  if (!setting) {
    return {
      ok: true,
      detail: 'coverage is never deferred to CI on this host',
    };
  }
  const check = gate.ciRatchetCheck;
  if (typeof check === 'string' && check.trim().length > 0) {
    return {
      ok: true,
      detail: `${setting} — CI check "${check}" ratchets deferred Stories`,
    };
  }
  return {
    ok: false,
    detail: `${setting} can defer coverage to CI, but no CI check is named to ratchet it — a deferred Story lands with no coverage or CRAP ratchet`,
    remedy: `Set ${KEY}.ciRatchetCheck to the CI check that runs .agents/scripts/coverage-ratchet.js on a deferred PR.`,
  };
}
