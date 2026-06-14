/**
 * init-tail.js — post-bootstrap onboarding tail for `mandrel init`.
 *
 * Called by `mandrel init` after `bootstrap.js` completes successfully on
 * the "configure now" path. Sequences the three phases that walk an operator
 * from a freshly bootstrapped project to a ready-to-plan workspace:
 *
 *   Phase 1 — Offer to scaffold missing docsContextFiles (scaffold-docs.js).
 *   Phase 2 — Run `mandrel doctor` as a readiness gate.
 *   Phase 3 — Print the /plan handoff next-step text.
 *
 * The whole tail is idempotent: re-running after an already-onboarded project
 * re-checks and re-offers scaffolding without duplicating stubs (the scaffolder
 * only writes genuinely absent files) and without modifying anything (doctor is
 * read-only).
 *
 * Injectable seams: `runDoctor`, `stdout`, `confirmScaffold`, and `isTTY`
 * allow the unit suite to drive every branch without real I/O.
 *
 * Story #4045 (refs #4045).
 */

import { spawnSync as defaultSpawnSync } from 'node:child_process';
import path from 'node:path';
import readline from 'node:readline/promises';

import { STUB_MARKER, scaffoldDocs } from './scaffold-docs.js';

// ---------------------------------------------------------------------------
// Phase text constants
// ---------------------------------------------------------------------------

/**
 * Text printed at the end of the init tail to hand the operator off to /plan.
 *
 * @type {string}
 */
export const PLAN_HANDOFF_TEXT =
  '\n✅  Mandrel is ready. Start your first project:\n\n' +
  '    /plan --idea "<one-line description of what you want to build>"\n\n' +
  'Or, if you already have a `type::epic` Issue open:\n\n' +
  '    /plan <epicId>\n';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Format a list of missing docs as a human-readable report (no prompt).
 *
 * @param {string[]} missing
 * @returns {string}
 */
function formatMissingList(missing) {
  if (missing.length === 0) return '';
  const list = missing.map((f) => `  • ${f}`).join('\n');
  return (
    '\n[Final Checks] The following docsContextFiles are missing,\n' +
    'agents will load degraded context until you create them:\n' +
    `${list}\n`
  );
}

/** Prompt text shown only on a TTY when asking to scaffold. */
const SCAFFOLD_PROMPT = '\nCreate placeholders? [Y/n]: ';

/**
 * Async y/N read from stdin via `node:readline` (mirrors the prompt mechanism
 * in `bootstrap.js`). Returns on Enter and never blocks waiting for EOF the way
 * `fs.readFileSync(0)` did — that EOF-blocking read hung `mandrel init` on an
 * interactive TTY. Yes is the default (`[Y/n]`): a bare Enter — or anything but
 * an explicit `n`/`no` — resolves to `true` (create the placeholders), since the
 * missing docs are known-needed and the stubs carry a `MANDREL:STUB` marker the
 * `/plan` preflight still flags until they are fleshed out. A read error
 * resolves to `false` so a genuine I/O failure never writes unattended. The
 * prompt text is written by the caller via `stdout`, so the question string
 * passed here is empty.
 *
 * `terminal: false` is **load-bearing**: with terminal mode on (the default
 * when stdout is a TTY) readline emits cursor-control escapes
 * (`\x1b[1G\x1b[0J`) that erase the `Create placeholders? [Y/n]:` prompt already
 * written via the caller's `stdout`, leaving the operator staring at a blank,
 * dead-looking line. Disabling terminal mode preserves the pre-written prompt
 * and reads the line via the TTY's cooked-mode echo. `createInterface` is
 * injectable so a test can assert this option is set (regression guard).
 *
 * @param {{ createInterface?: typeof readline.createInterface }} [opts]
 * @returns {Promise<boolean>}
 */
export async function readConfirm({
  createInterface = readline.createInterface,
} = {}) {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false,
  });
  try {
    const answer = (await rl.question('')).trim().toLowerCase();
    return answer !== 'n' && answer !== 'no';
  } catch {
    return false;
  } finally {
    rl.close();
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run the post-bootstrap init tail.
 *
 * @param {object} [opts]
 * @param {string} [opts.root] - Project root (defaults to `process.cwd()`).
 * @param {(msg: string) => void} [opts.stdout] - Output sink (defaults to
 *   `process.stdout.write` bound to `process.stdout`).
 * @param {() => boolean} [opts.confirmScaffold] - Read the operator's y/N
 *   answer for the scaffold offer. Returns `true` to scaffold. In non-TTY
 *   contexts defaults to `false` (no write without operator confirmation).
 * @param {(extraArgs?: string[]) => { status: number|null }} [opts.runDoctor]
 *   - Run `mandrel doctor`; injectable for tests.
 * @param {boolean} [opts.isTTY] - Whether stdin is a TTY (defaults to
 *   `Boolean(process.stdin.isTTY)`).
 * @returns {Promise<{
 *   scaffoldResult: object,
 *   doctorStatus: number,
 *   ok: boolean,
 * }>}
 */
export async function runInitTail({
  root,
  stdout = (s) => process.stdout.write(s),
  confirmScaffold,
  runDoctor,
  isTTY,
} = {}) {
  const projectRoot = root ?? process.cwd();
  const tty = isTTY ?? Boolean(process.stdin.isTTY);

  // When confirmScaffold is explicitly injected (e.g. from tests), always use
  // it. When using the default, auto-decline on non-TTY so the scaffolder
  // never writes unattended.
  const usingDefaultConfirm = confirmScaffold == null;
  const confirmFn = confirmScaffold ?? readConfirm;

  // Default doctor runner — spawns `mandrel doctor` via the locally installed
  // bin; inherits stdio so the report streams to the terminal.
  const mandrelBin = path.join(
    projectRoot,
    'node_modules',
    'mandrel',
    'bin',
    'mandrel.js',
  );
  const defaultRunDoctor = (extraArgs = []) =>
    defaultSpawnSync(process.execPath, [mandrelBin, 'doctor', ...extraArgs], {
      cwd: projectRoot,
      stdio: 'inherit',
    });

  const doctorFn = runDoctor ?? defaultRunDoctor;

  // --- Phase 1: Offer to scaffold missing docsContextFiles -----------------
  const preview = scaffoldDocs({ root: projectRoot, write: false });
  let scaffoldResult = preview;

  if (preview.missing.length === 0) {
    stdout('\n[Final Checks] All docsContextFiles are present.\n');
  } else {
    stdout(formatMissingList(preview.missing));
    // On non-TTY without an injected confirm, auto-decline so the scaffolder
    // never writes unattended. On TTY (or with an injected confirm seam), show
    // the prompt and consult the confirm function.
    const canPrompt = tty || !usingDefaultConfirm;
    if (canPrompt) stdout(SCAFFOLD_PROMPT);
    const accepted = canPrompt ? await confirmFn() : false;
    if (accepted) {
      scaffoldResult = scaffoldDocs({ root: projectRoot, write: true });
      if (scaffoldResult.created.length > 0) {
        stdout(
          `[Final Checks] Scaffolded ${scaffoldResult.created.length} stub(s). ` +
            `Each carries a \`${STUB_MARKER}\` marker — replace placeholder ` +
            'content before planning.\n',
        );
      }
    } else {
      stdout('[Final Checks] Placeholders declined.\n');
    }
  }

  // --- Phase 2: Readiness gate (mandrel doctor) ----------------------------
  stdout('\n[Final Checks] Final installation summary via mandrel doctor…\n');
  const doctorResult = doctorFn();
  const doctorStatus = doctorResult?.status ?? 1;

  if (doctorStatus !== 0) {
    stdout(
      '\n[Final Checks] ❌  Doctor check failed. Resolve the remedies above and\n' +
        'then re-run: mandrel init\n',
    );
    return { scaffoldResult, doctorStatus, ok: false };
  }

  // --- Phase 3: Handoff to /plan -------------------------------------------
  stdout(PLAN_HANDOFF_TEXT);
  return { scaffoldResult, doctorStatus, ok: true };
}
