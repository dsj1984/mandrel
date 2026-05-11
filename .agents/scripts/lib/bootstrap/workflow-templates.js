/**
 * bootstrap/workflow-templates — Epic #1235 Story 5
 *
 * Copies the framework's CI-pipeline template files into a consumer repo:
 *   - `.github/workflows/triage-pr-failure.yml` (Story 2)
 *   - `.github/workflows/auto-fix.yml`          (Story 4)
 *   - `.agents/scripts/triage-ci-failure.js`    (Story 2)
 *   - `.agents/scripts/auto-fix-step.js`        (Story 4)
 *   - `.agents/scripts/auto-fix-bail.js`        (Story 4)
 *   - `.agents/scripts/lib/triage/*.js`         (Story 2)
 *   - `.agents/scripts/lib/auto-fix/*.js`       (Story 4)
 *
 * Source-of-truth lives under `.agents/templates/` inside this repo so
 * the framework can ship updates by re-running `/agents-bootstrap-github`
 * on every consumer.
 *
 * Behaviour rules
 * ---------------
 * - **Missing on target** — copy without prompting. First-run consumers
 *   get the framework pipeline by default (opt-out via subsequent
 *   operator deletion + re-run skip; we don't try to be smarter).
 * - **Identical to target** — no-op. Re-running is idempotent.
 * - **Drifted on target** — route through `hitlConfirm` before
 *   overwriting. Drift means the operator (or a stale earlier framework
 *   release) wrote something different; we must not silently clobber
 *   that.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// `.agents/scripts/lib/bootstrap/` → `.agents/templates/`
const TEMPLATE_ROOT = path.resolve(__dirname, '..', '..', '..', 'templates');

/**
 * The canonical template manifest. Each entry maps a source file under
 * `.agents/templates/` to its destination path inside the target repo.
 * Adding a new template file is a one-line addition here.
 */
export const TEMPLATE_MANIFEST = [
  {
    source: 'workflows/triage-pr-failure.yml',
    target: '.github/workflows/triage-pr-failure.yml',
  },
  {
    source: 'workflows/auto-fix.yml',
    target: '.github/workflows/auto-fix.yml',
  },
  {
    source: 'scripts/triage-ci-failure.js',
    target: '.agents/scripts/triage-ci-failure.js',
  },
  {
    source: 'scripts/auto-fix-step.js',
    target: '.agents/scripts/auto-fix-step.js',
  },
  {
    source: 'scripts/auto-fix-bail.js',
    target: '.agents/scripts/auto-fix-bail.js',
  },
  {
    source: 'scripts/lib/triage/parse-crap-report.js',
    target: '.agents/scripts/lib/triage/parse-crap-report.js',
  },
  {
    source: 'scripts/lib/triage/parse-test-output.js',
    target: '.agents/scripts/lib/triage/parse-test-output.js',
  },
  {
    source: 'scripts/lib/triage/render-comment.js',
    target: '.agents/scripts/lib/triage/render-comment.js',
  },
  {
    source: 'scripts/lib/auto-fix/detect-failure-class.js',
    target: '.agents/scripts/lib/auto-fix/detect-failure-class.js',
  },
];

async function tryReadFile(p) {
  try {
    return await fs.readFile(p, 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * @param {object} args
 * @param {string} args.targetRoot - Absolute path to the consumer repo root.
 * @param {(args:{summary:string, current:string, proposed:string})=>Promise<boolean>}
 *   [args.hitlConfirm] - HITL gate for drifted files.
 * @param {string} [args.templateRoot] - Override for tests; defaults to
 *   `.agents/templates/` next to this module.
 * @param {(msg:string)=>void} [args.log] - Logger sink.
 */
export async function copyWorkflowTemplates({
  targetRoot,
  hitlConfirm,
  templateRoot = TEMPLATE_ROOT,
  log = () => {},
}) {
  if (!targetRoot) {
    throw new Error(
      '[bootstrap] copyWorkflowTemplates: targetRoot is required',
    );
  }
  const summary = { copied: [], unchanged: [], skipped: [], drifted: [] };

  for (const entry of TEMPLATE_MANIFEST) {
    const sourcePath = path.join(templateRoot, entry.source);
    const targetPath = path.join(targetRoot, entry.target);

    const sourceContent = await fs.readFile(sourcePath, 'utf8');
    const liveContent = await tryReadFile(targetPath);

    if (liveContent === null) {
      // Missing on target — copy without prompting.
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      await fs.writeFile(targetPath, sourceContent, 'utf8');
      summary.copied.push(entry.target);
      log(`[bootstrap] Workflow template: created ${entry.target}.`);
      continue;
    }

    if (liveContent === sourceContent) {
      summary.unchanged.push(entry.target);
      continue;
    }

    // Drift — route through HITL.
    const approved =
      typeof hitlConfirm === 'function'
        ? await hitlConfirm({
            summary: `Workflow template ${entry.target} has drifted from the framework source.`,
            current: liveContent,
            proposed: sourceContent,
          })
        : false;
    if (!approved) {
      summary.drifted.push(entry.target);
      log(
        `[bootstrap] Workflow template: ${entry.target} drifted; HITL declined / non-TTY — leaving target untouched.`,
      );
      continue;
    }

    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, sourceContent, 'utf8');
    summary.copied.push(entry.target);
    log(
      `[bootstrap] Workflow template: overwrote ${entry.target} (HITL-approved).`,
    );
  }

  return summary;
}
