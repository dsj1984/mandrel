/**
 * pr-watch-poll.js — the pure outcome helpers and the bounded poll loop
 * behind `watchPrToTerminal` (pr-watch.js).
 */

import { checkVerdict, classifyRequiredCheck } from './check-state.js';

/** Entries with a string `name`; `[]` for malformed input. */
export function parseGhPrChecks(stdout) {
  const trimmed = String(stdout ?? '').trim();
  if (trimmed.length === 0) return [];
  try {
    const parsed = JSON.parse(trimmed);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (e) => e && typeof e === 'object' && typeof e.name === 'string',
    );
  } catch {
    return [];
  }
}

/** `{ checkName: outcome }`; a repeated name (matrix, retry) — last wins. */
export function reduceOutcomes(entries) {
  const out = {};
  for (const e of entries) {
    out[e.name] = classifyRequiredCheck(e);
  }
  return out;
}

/** Only `'pending'` is non-terminal (the classifier collapses running states). */
export function allTerminal(outcomes) {
  for (const v of Object.values(outcomes)) {
    if (v === 'pending') return false;
  }
  return true;
}

/** Slow CI, not red: "re-arm the watch", never "the change is broken". */
const STILL_RUNNING = 'still-running';

/** Leftover `'pending'` → `'still-running'` (the schema forbids pending). */
export function promotePendingToStillRunning(outcomes) {
  const out = {};
  for (const [k, v] of Object.entries(outcomes)) {
    out[k] = v === 'pending' ? STILL_RUNNING : v;
  }
  return out;
}

/** A genuinely red check: the hard stop that consumes no resume budget. */
export function hasFailingCheck(outcomes) {
  return Object.values(outcomes).some((v) => checkVerdict(v) === 'fail');
}

async function identityDiscount(_entries, outcomes) {
  return outcomes;
}

/**
 * A transient `gh` failure is skipped; `maxPolls` bounds a broken `gh`.
 *
 * @param {object} opts
 * @param {string} opts.prUrl
 * @param {string} opts.cwd
 * @param {string|null} [opts.repo] `owner/repo` passed to `gh` as `--repo`.
 * @param {object} opts.outcomes  Initial `{ checkName: outcome }` map.
 * @param {number} opts.polls     Current poll counter.
 * @param {number} opts.maxPolls  Hard cap on total poll iterations.
 * @param {Function} opts.ghPrChecksFn
 * @param {number} opts.pollIntervalMs
 * @param {Function} opts.sleepFn
 * @param {Function} [opts.discountFn]
 * @param {{ warn?: Function }} opts.logger
 * @returns {Promise<{ outcomes: object, polls: number }>}
 */
export async function pollUntilTerminal({
  prUrl,
  cwd,
  repo = null,
  outcomes,
  polls,
  maxPolls,
  ghPrChecksFn,
  pollIntervalMs,
  sleepFn,
  discountFn = identityDiscount,
  logger,
}) {
  let currentOutcomes = outcomes;
  let currentPolls = polls;
  while (!allTerminal(currentOutcomes) && currentPolls < maxPolls) {
    await sleepFn(pollIntervalMs);
    currentPolls += 1;
    const probe = ghPrChecksFn({ prUrl, cwd, repo });
    const entries = parseGhPrChecks(probe.stdout);
    if (entries.length === 0 && probe.status !== 0 && probe.status !== 8) {
      logger.warn?.(
        `[Watcher] gh pr checks transient failure (status=${probe.status}): ${probe.stderr}`,
      );
      continue;
    }
    currentOutcomes = await discountFn(entries, reduceOutcomes(entries));
  }
  return { outcomes: currentOutcomes, polls: currentPolls };
}
