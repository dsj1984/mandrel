#!/usr/bin/env node
/**
 * check-prepush-recovery.js — gate decision for the pre-push coverage step.
 *
 * Story #3162. The pre-push hook normally runs `coverage-capture.js` +
 * `crap:check` on every push. During a `story-close.js` recovery (operator
 * pushing `epic/<id>` to unblock a run after a merge-orchestrator failure),
 * a pre-existing coverage regression on `epic/<id>` — unrelated to the
 * Story under recovery — hard-blocks the push and forces a `--no-verify`
 * bypass, which violates the global "no hook bypass" rule.
 *
 * This script is the scoped escape hatch. It exits 0 ("skip coverage gate")
 * only when BOTH conditions hold:
 *
 *   1. `STORY_CLOSE_RECOVERY=1` is set in the environment.
 *   2. At least one ref being pushed has a local ref of the shape
 *      `refs/heads/epic/<id>` (parsed from the pre-push stdin protocol).
 *
 * Otherwise it exits 1 ("run coverage gate as today"). The narrow scope is
 * deliberate: a generic env-var bypass would erode the gate; tying the
 * skip to an epic-branch target keeps every other push honest.
 *
 * Stdin contract (git pre-push hook protocol): zero or more lines, each
 *   `<local_ref> <local_sha> <remote_ref> <remote_sha>`
 * separated by whitespace. Empty stdin (no refs being pushed) yields exit 1.
 */

import { runAsCli } from './lib/cli-utils.js';

const EPIC_REF_PATTERN = /^refs\/heads\/epic\//;
const SKIP_LOG = '[pre-push] coverage gate skipped by STORY_CLOSE_RECOVERY';

/**
 * Parse pre-push stdin into the list of local refs being pushed. Lines with
 * fewer than four whitespace-separated tokens are tolerated (git in practice
 * always emits four, but defensive parsing keeps the helper robust against
 * empty pushes and trailing whitespace).
 *
 * @param {string} stdin
 * @returns {string[]} local ref names (first token of each non-empty line)
 */
export function parsePrePushLocalRefs(stdin) {
  if (typeof stdin !== 'string' || stdin.length === 0) return [];
  return stdin
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.split(/\s+/)[0])
    .filter(Boolean);
}

/**
 * Pure decision function. `true` means "skip the coverage gate".
 *
 * @param {object} input
 * @param {string|undefined} input.env  value of STORY_CLOSE_RECOVERY
 * @param {string[]} input.localRefs    parsed local refs
 * @returns {boolean}
 */
export function shouldSkipCoverageGate({ env, localRefs }) {
  if (env !== '1') return false;
  if (!Array.isArray(localRefs) || localRefs.length === 0) return false;
  return localRefs.some((ref) => EPIC_REF_PATTERN.test(ref));
}

async function readStdin() {
  if (process.stdin.isTTY) return '';
  let data = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

async function main() {
  const stdin = await readStdin();
  const localRefs = parsePrePushLocalRefs(stdin);
  const skip = shouldSkipCoverageGate({
    env: process.env.STORY_CLOSE_RECOVERY,
    localRefs,
  });
  if (skip) {
    process.stdout.write(`${SKIP_LOG}\n`);
    process.exit(0);
  }
  process.exit(1);
}

runAsCli(import.meta.url, main);

export const __testing = { EPIC_REF_PATTERN, SKIP_LOG };
