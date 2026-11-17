// .agents/scripts/lib/orchestration/block-class-recovery.js
/**
 * block-class-recovery.js — who clears each terminal block class: the
 * delivering session (`agent`) or a human (`operator`).
 */

import {
  ADVISORY_GATE_INCONCLUSIVE_CLASS,
  ADVISORY_GATE_RED_CLASS,
  CHECKS_FAILED_CLASS,
} from './merge-poll.js';

/**
 * Who clears each block: `agent` classes have a remedy the delivering session
 * executes itself (fix + push, rerun, re-confirm), so they are not the HITL
 * pause; `operator` classes need a setting, approval or decision the agent
 * cannot make.
 */
export const BLOCK_CLASS_RECOVERY = Object.freeze({
  [CHECKS_FAILED_CLASS]: 'agent',
  'checks-pending-timeout': 'agent',
  'branch-protection-human-required': 'operator',
  'arm-failure': 'operator',
  'api-race-other': 'agent',
  'predicate-refused': 'operator',
  [ADVISORY_GATE_RED_CLASS]: 'agent',
  [ADVISORY_GATE_INCONCLUSIVE_CLASS]: 'agent',
  'merge-queue-rest-unsupported': 'operator',
  'queue-ejected': 'agent',
  'merged-flip-failed': 'agent',
});

/**
 * @param {string} blockClass
 * @returns {'agent'|'operator'}
 * @throws {Error} on a class the table does not cover.
 */
export function recoveryOf(blockClass) {
  const recovery = BLOCK_CLASS_RECOVERY[blockClass];
  if (!recovery) {
    throw new Error(`recoveryOf: unclassified block class "${blockClass}"`);
  }
  return recovery;
}
