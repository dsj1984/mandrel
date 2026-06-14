/**
 * bootstrap/hitl-confirm — Epic #1235 Story 5; consent-first opt-in (#3526)
 *
 * Renders a structured diff to stdout and prompts the operator y/N when
 * stdout is a TTY. When not a TTY (CI, sub-agent, redirected pipe), the
 * gate returns `false` and logs the canonical abort message to stderr —
 * silent-apply is a non-feature. The `opts.assume` override lets tests
 * and automation pin the answer deterministically:
 *
 *   - `opts.assume === 'yes'` → returns true, skips the prompt entirely.
 *   - `opts.assume === 'no'`  → returns false, skips the prompt.
 *
 * The default render is intentionally simple: a single-line summary
 * followed by a JSON dump of `{ current, proposed }`. Callers that want
 * a richer view (per-field colour, contextual unified diff) can wrap
 * `confirm` and render their own preamble before calling.
 *
 * Consent-first install (Story #3526): the GitHub-admin phase group — the
 * irreversible remote mutations (labels, Projects V2, branch protection,
 * merge methods) — is gated by an explicit opt-in, not merely a TTY. A
 * non-TTY run that has not opted in records every group as declined, so the
 * abort hint names BOTH the dedicated `--approve-github-admin` flag (consent
 * to just the remote mutations) and `--assume-yes` (accept every group).
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
 * }} [opts] - Overrides for tests / automation. `isTTY` defaults to
 *   `process.stdout.isTTY`. `stdin`/`stdout`/`stderr` default to the
 *   respective `process.*` streams.
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

  // Render the diff. Single-line summary, then a JSON block so the
  // operator can pipe the prompt to a logger and still recover the
  // structured shape.
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

// Re-export the abort message so tests can assert against the single
// source of truth.
export { ABORT_MESSAGE };
