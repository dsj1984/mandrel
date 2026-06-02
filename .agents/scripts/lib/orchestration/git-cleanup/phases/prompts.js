/**
 * prompts.js — readline-based interactive prompts for git-cleanup
 * (Story #2466).
 *
 * Split out of `cli.js` so each phase file stays under Story #2466's
 * 200-LOC ceiling. Exports two helpers used by the per-phase drivers:
 *
 *   - `promptYesNo(question)` — read a single y/N line and resolve true
 *     on `y` / `yes` (case-insensitive), false otherwise.
 *   - `promptStashDecision(entry)` — per-stash drop/keep/quit prompt
 *     used as the `decideFn` argument to `executeStashes`.
 *
 * Both helpers open a fresh readline interface and close it inside a
 * `try`/`finally` so the process can still exit cleanly.
 *
 * @module lib/orchestration/git-cleanup/phases/prompts
 */

import readline from 'node:readline';

const TAG = '[git-cleanup]';

/**
 * Map a raw stash-prompt answer to a decision verdict. Pure: trims and
 * lowercases the input, then classifies it as `drop` / `quit` / `keep`.
 * `drop` covers `d`/`drop`/`y`/`yes`; `quit` covers `q`/`quit`; anything
 * else (including empty) defaults to the safe `keep`.
 *
 * @param {string} answer
 * @returns {'drop' | 'keep' | 'quit'}
 */
export function decideStashAnswer(answer) {
  const t = (answer ?? '').trim().toLowerCase();
  if (t === 'd' || t === 'drop' || t === 'y' || t === 'yes') return 'drop';
  if (t === 'q' || t === 'quit') return 'quit';
  return 'keep';
}

/* node:coverage ignore next */
export async function promptYesNo(question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const ans = await new Promise((resolve) => {
      rl.question(`${question} [y/N] `, (a) => resolve(a));
    });
    return /^y(es)?$/i.test(ans.trim());
  } finally {
    rl.close();
  }
}

/* node:coverage ignore next */
export async function promptStashDecision(entry) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const ans = await new Promise((resolve) => {
      rl.question(
        `${TAG} ${entry.ref} (${entry.createdAt}) ${entry.message} — drop/keep/quit [k]? `,
        (a) => resolve(a),
      );
    });
    return decideStashAnswer(ans);
  } finally {
    rl.close();
  }
}
