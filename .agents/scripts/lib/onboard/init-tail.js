/**
 * init-tail.js — `mandrel init`'s post-bootstrap tail: offer to scaffold
 * missing docsContextFiles, gate on `mandrel doctor`, then print the
 * `/mandrel-plan` handoff. Idempotent: the scaffolder writes only absent
 * files and doctor is read-only.
 */

import { spawnSync as defaultSpawnSync } from 'node:child_process';
import path from 'node:path';
import readline from 'node:readline/promises';

import { STUB_MARKER, scaffoldDocs } from './scaffold-docs.js';

/**
 * @type {string}
 */
export const PLAN_HANDOFF_TEXT =
  '\n✅  Mandrel is ready. Start your first project:\n\n' +
  '    /mandrel-plan --seed "<one-line description of what you want to build>"\n';

/**
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
const SCAFFOLD_PROMPT = '\nCreate placeholders? [y/N]: ';

/**
 * y/N (default No; a read error declines). Readline, because a blocking
 * `fs.readFileSync(0)` hangs on a TTY. `terminal: false` is load-bearing:
 * terminal mode's cursor escapes erase the caller's pre-written prompt.
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
    return answer === 'y' || answer === 'yes';
  } catch {
    return false;
  } finally {
    rl.close();
  }
}

/**
 * @param {object} [opts]
 * @param {string} [opts.root]
 * @param {(msg: string) => void} [opts.stdout]
 * @param {() => boolean} [opts.confirmScaffold]
 * @param {(extraArgs?: string[]) => { status: number|null }} [opts.runDoctor]
 * @param {boolean} [opts.isTTY]
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

  // An injected confirm is always consulted; the default auto-declines off a
  // TTY so the scaffolder never writes unattended.
  const usingDefaultConfirm = confirmScaffold == null;
  const confirmFn = confirmScaffold ?? readConfirm;

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

  const preview = scaffoldDocs({ root: projectRoot, write: false });
  let scaffoldResult = preview;

  if (preview.missing.length === 0) {
    stdout('\n[Final Checks] All docsContextFiles are present.\n');
  } else {
    stdout(formatMissingList(preview.missing));
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

  stdout(PLAN_HANDOFF_TEXT);
  return { scaffoldResult, doctorStatus, ok: true };
}
