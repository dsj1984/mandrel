/**
 * Readline prompts for git-cleanup. Each opens a fresh interface and closes
 * it in `finally` so the process can exit cleanly.
 *
 * @module lib/orchestration/git-cleanup/phases/prompts
 */

import readline from 'node:readline';

const TAG = '[git-cleanup]';

/**
 * Anything unrecognised, including empty, defaults to the safe `keep`.
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
