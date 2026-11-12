// lib/cli/doctor-checks/suite-ownership.js — Doctor check: suite-ownership.

import fs from 'node:fs';
import { readEffectiveAgentrc } from './effective-agentrc.js';

const KEY = 'delivery.quality.gates.coverage';

const isSet = (value) => typeof value === 'string' && value.trim().length > 0;

/**
 * Advisory: who runs the suite before a PR. Reports a suite owned by both the
 * handoff and CI (`ciRatchetCheck` set, posture local), and a `ci` posture
 * with no `project.commands.testChanged` guard. Never fails.
 *
 * @param {{ projectRoot?: string, cwd?: () => string, fsImpl?: { readFileSync: Function, existsSync: Function } }} [opts]
 * @returns {Promise<{ ok: true, detail: string }>}
 */
export async function runSuiteOwnership({
  projectRoot,
  cwd,
  fsImpl = fs,
} = {}) {
  const root = projectRoot ?? (cwd ?? (() => process.cwd()))();
  const agentrc = readEffectiveAgentrc(root, fsImpl);
  const gate = agentrc?.delivery?.quality?.gates?.coverage ?? {};
  const guard = agentrc?.project?.commands?.testChanged;
  if (gate.suiteOfRecord === 'ci') {
    return {
      ok: true,
      detail: isSet(guard)
        ? `CI owns the suite; the handoff runs \`${guard.trim()}\` (project.commands.testChanged) as a changed-tests guard`
        : 'CI owns the suite and no test runs before the PR — set project.commands.testChanged to run a changed-tests guard at the handoff',
    };
  }
  if (isSet(gate.ciRatchetCheck)) {
    return {
      ok: true,
      detail: `the suite is owned by both the handoff and CI ("${gate.ciRatchetCheck}") — set ${KEY}.suiteOfRecord: "ci" to make CI its owner, plus project.commands.testChanged for a changed-tests guard`,
    };
  }
  return { ok: true, detail: 'the handoff owns the suite' };
}
