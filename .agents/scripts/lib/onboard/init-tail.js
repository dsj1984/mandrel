/**
 * init-tail.js — post-bootstrap onboarding tail for `mandrel init`.
 *
 * Called by `mandrel init` after `bootstrap.js` completes successfully on
 * the "configure now" path. Sequences the four phases that walk an operator
 * from a freshly bootstrapped project to a ready-to-plan workspace:
 *
 *   Phase 1 — Detect the consumer stack (lib/onboard/detect-stack.js).
 *   Phase 2 — Offer to scaffold missing docsContextFiles (scaffold-docs.js).
 *   Phase 3 — Run `mandrel doctor` as a readiness gate.
 *   Phase 4 — Print the /plan handoff next-step text.
 *
 * The whole tail is idempotent: re-running after an already-onboarded project
 * re-detects, re-checks, and re-offers scaffolding without duplicating stubs
 * (the scaffolder only writes genuinely absent files) and without modifying
 * anything (doctor is read-only).
 *
 * Injectable seams: `runDoctor`, `stdout`, `confirmScaffold`, and `isTTY`
 * allow the unit suite to drive every branch without real I/O.
 *
 * Story #4045 (refs #4045).
 */

import { spawnSync as defaultSpawnSync } from 'node:child_process';
import path from 'node:path';
import readline from 'node:readline/promises';

import { detectStack } from './detect-stack.js';
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
  '\n✅  Mandrel is ready. Start your first Epic:\n\n' +
  '    /plan --idea "<one-line description of what you want to build>"\n\n' +
  'Or, if you already have a `type::epic` Issue open:\n\n' +
  '    /plan <epicId>\n';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Format a stack-detection result as a human-readable report line.
 *
 * @param {{ packageManager: string|null, testRunner: string|null, primaryLanguage: string|null }} stack
 * @returns {string}
 */
function formatStackReport(stack) {
  const pm = stack.packageManager ?? '(unknown)';
  const runner = stack.testRunner ?? '(unknown)';
  const lang = stack.primaryLanguage ?? '(unknown)';
  return (
    '\n[init] Stack detection:\n' +
    `  Package manager : ${pm}\n` +
    `  Test runner     : ${runner}\n` +
    `  Primary language: ${lang}\n`
  );
}

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
    '\n[init] The following docsContextFiles are missing — agents load\n' +
    'these before every task:\n' +
    `${list}\n`
  );
}

/** Prompt text shown only on a TTY when asking to scaffold. */
const SCAFFOLD_PROMPT = '\nScaffold stubs now? [y/N]: ';

/**
 * Async y/N read from stdin via `node:readline` (mirrors the prompt mechanism
 * in `bootstrap.js`). Returns on Enter and never blocks waiting for EOF the way
 * `fs.readFileSync(0)` did — that EOF-blocking read hung `mandrel init` on an
 * interactive TTY. Returns `false` on any read error or when the user enters
 * something other than `y` / `yes`. The prompt text is written by the caller
 * via `stdout`, so the question string passed here is empty.
 *
 * @returns {Promise<boolean>}
 */
async function readConfirm() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const answer = (await rl.question('')).trim().toLowerCase();
    return answer === 'y' || answer === 'yes';
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
 *   stack: { packageManager: string|null, testRunner: string|null, primaryLanguage: string|null },
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

  // --- Phase 1: Detect the stack -------------------------------------------
  let stack;
  try {
    stack = detectStack(projectRoot);
  } catch {
    stack = { packageManager: null, testRunner: null, primaryLanguage: null };
  }
  stdout(formatStackReport(stack));

  // --- Phase 2: Offer to scaffold missing docsContextFiles -----------------
  const preview = scaffoldDocs({ root: projectRoot, write: false });
  let scaffoldResult = preview;

  if (preview.missing.length === 0) {
    stdout('\n[init] All docsContextFiles are present.\n');
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
          `[init] Scaffolded ${scaffoldResult.created.length} stub(s). ` +
            `Each carries a \`${STUB_MARKER}\` marker — replace placeholder ` +
            'content before planning.\n',
        );
      }
    } else {
      stdout(
        '[init] Scaffolding declined. docsContextFiles are still missing — ' +
          'agents will load degraded context until you create them.\n',
      );
    }
  }

  // --- Phase 3: Readiness gate (mandrel doctor) ----------------------------
  stdout('\n[init] Running mandrel doctor…\n');
  const doctorResult = doctorFn();
  const doctorStatus = doctorResult?.status ?? 1;

  if (doctorStatus !== 0) {
    stdout(
      '\n[init] ❌  Doctor check failed. Resolve the remedies above and\n' +
        'then re-run: mandrel init\n',
    );
    return { stack, scaffoldResult, doctorStatus, ok: false };
  }

  // --- Phase 4: Handoff to /plan -------------------------------------------
  stdout(PLAN_HANDOFF_TEXT);
  return { stack, scaffoldResult, doctorStatus, ok: true };
}
