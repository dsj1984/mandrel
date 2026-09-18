/**
 * y/N confirm of a `{ current, proposed }` diff. Without a TTY it returns
 * `false` and logs the abort hint — never a silent apply. `opts.assume` pins
 * the answer. Irreversible GitHub-admin mutations need an explicit opt-in,
 * so the hint names both `--approve-github-admin` and `--assume-yes`.
 */

import { createInterface } from 'node:readline';

const ABORT_MESSAGE =
  '[Bootstrap] aborting: no TTY available for HITL confirm (opt in with --approve-github-admin for GitHub-admin mutations, or --assume-yes to accept every phase group)';

/**
 * @param {object} args
 * @param {string} args.summary - One-line description of the diff.
 * @param {*} [args.current] - Live state (rendered as JSON).
 * @param {*} [args.proposed] - Target state (rendered as JSON).
 * @param {{
 *   assume?: 'yes' | 'no',
 *   stdin?: NodeJS.ReadableStream,
 *   stdout?: NodeJS.WritableStream,
 *   stderr?: NodeJS.WritableStream,
 *   isTTY?: boolean,
 * }} [opts]
 * @returns {Promise<boolean>} - true ⇒ apply, false ⇒ abort.
 */
export async function confirm({ summary, current, proposed }, opts = {}) {
  if (opts.assume === 'yes') return true;
  if (opts.assume === 'no') return false;

  const stdout = opts.stdout ?? process.stdout;
  const stderr = opts.stderr ?? process.stderr;
  const stdin = opts.stdin ?? process.stdin;
  const isTTY = opts.isTTY ?? stdout?.isTTY ?? false;

  if (!isTTY) {
    stderr.write(`${ABORT_MESSAGE}\n`);
    return false;
  }

  stdout.write(`\nHITL confirm: ${summary}\n`);
  stdout.write(
    `  current:  ${JSON.stringify(current ?? null, null, 2)
      .split('\n')
      .join('\n  ')}\n`,
  );
  stdout.write(
    `  proposed: ${JSON.stringify(proposed ?? null, null, 2)
      .split('\n')
      .join('\n  ')}\n`,
  );

  const rl = createInterface({ input: stdin, output: stdout, terminal: false });
  try {
    const answer = await new Promise((resolve) => {
      rl.question('  apply? [y/N] ', resolve);
    });
    return /^y(es)?$/i.test(String(answer).trim());
  } finally {
    rl.close();
  }
}

export { ABORT_MESSAGE };
