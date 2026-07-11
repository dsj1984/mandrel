#!/usr/bin/env node
/**
 * .agents/scripts/generate-lens-checklists.js — per-lens authoring checklists
 *
 * Distils each canonical audit lens's own `.agents/workflows/audit-<lens>.md`
 * workflow body into one compact authoring checklist under
 * `.agents/audit-checklists/<lens>.md`. The distillation logic is the pure
 * `lib/audit-suite/lens-checklist.js` seam; this entry point owns only the
 * file read/write/prune and the `--check` drift gate.
 *
 * Why (Epic #4405 — shift-left audit): the audit lenses used to surface their
 * concerns only when `/audit-<lens>` ran. These checklists move the concerns to
 * the innermost, write-time tier as committed build artifacts, gated for
 * staleness by `npm run docs:check` exactly like every other generated doc so
 * they can never silently drift from their source workflow.
 *
 * The lens taxonomy is the SSOT `AUDIT_LENSES` list. A lens whose
 * `audit-<lens>.md` workflow is absent produces **no** checklist and is
 * reported (never a silent skip). Stray `.md` files under the checklist
 * directory that no longer map to a lens are pruned in write mode and flagged
 * in `--check` mode, keeping the directory a pure function of its sources.
 *
 * Modes:
 *   (default)  — writes one `<lens>.md` per lens with a workflow, prunes
 *                strays, reports lenses missing a workflow.
 *   --check    — exits 0 when every on-disk file matches the freshly generated
 *                content and no strays exist, throws (→ exit 1) otherwise.
 *
 * Per `.agents/rules/orchestration-error-handling.md`, unrecoverable failures
 * surface via `throw new Error(...)` so `runAsCli` maps the throw to
 * `process.exit(1)` deterministically (no `Logger.fatal`).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { renderLensChecklist } from './lib/audit-suite/lens-checklist.js';
import { AUDIT_LENSES } from './lib/audit-to-stories/audit-lenses.js';
import { runAsCli } from './lib/cli-utils.js';
import { Logger } from './lib/Logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const WORKFLOWS_DIR = path.join(PROJECT_ROOT, '.agents', 'workflows');
const CHECKLISTS_DIR = path.join(PROJECT_ROOT, '.agents', 'audit-checklists');

/**
 * Pure: plan the expected checklist set from the lens taxonomy, given a
 * workflow-existence predicate and a reader. A lens whose workflow is absent
 * yields no checklist and is recorded in `missing` (never silently skipped).
 * Kept side-effect-free so it is unit-testable with fabricated inputs.
 *
 * @param {ReadonlyArray<string>} lenses — canonical lens names.
 * @param {(lens: string) => boolean} workflowExists
 * @param {(lens: string) => string} readWorkflow
 * @returns {{ expected: Map<string, string>, missing: string[] }}
 */
export function planChecklists(lenses, workflowExists, readWorkflow) {
  const expected = new Map();
  const missing = [];
  for (const lens of lenses) {
    if (!workflowExists(lens)) {
      missing.push(lens);
      continue;
    }
    expected.set(`${lens}.md`, renderLensChecklist(lens, readWorkflow(lens)));
  }
  return { expected, missing };
}

/**
 * Build the full expected checklist set from the lens taxonomy and the on-disk
 * workflow bodies, plus the strays (on-disk checklist files mapping to no
 * current lens).
 *
 * @returns {{
 *   expected: Map<string, string>,
 *   missing: string[],
 *   strays: string[],
 * }} `expected` maps a checklist basename (`<lens>.md`) to its generated
 *   content; `missing` lists lenses with no `audit-<lens>.md`; `strays` lists
 *   on-disk checklist basenames that map to no current lens.
 */
export function buildExpected() {
  const workflowPath = (lens) => path.join(WORKFLOWS_DIR, `audit-${lens}.md`);
  const { expected, missing } = planChecklists(
    AUDIT_LENSES,
    (lens) => fs.existsSync(workflowPath(lens)),
    (lens) => fs.readFileSync(workflowPath(lens), 'utf8'),
  );

  const onDisk = fs.existsSync(CHECKLISTS_DIR)
    ? fs.readdirSync(CHECKLISTS_DIR).filter((name) => name.endsWith('.md'))
    : [];
  const strays = onDisk.filter((name) => !expected.has(name));

  return { expected, missing, strays };
}

/**
 * @param {string} basename — e.g. `security.md`
 * @returns {string} repo-relative POSIX path for messages.
 */
function relChecklist(basename) {
  return path
    .relative(PROJECT_ROOT, path.join(CHECKLISTS_DIR, basename))
    .split(path.sep)
    .join('/');
}

/**
 * @param {string[]} argv
 */
async function main(argv = process.argv.slice(2)) {
  const { values } = parseArgs({
    args: argv,
    options: { check: { type: 'boolean', default: false } },
    allowPositionals: false,
  });

  const { expected, missing, strays } = buildExpected();

  if (missing.length > 0) {
    Logger.info(
      `generate-lens-checklists: no audit-<lens>.md for: ${missing.join(', ')} — no checklist emitted.`,
    );
  }

  if (values.check) {
    const drifted = [];
    for (const [basename, content] of expected) {
      const target = path.join(CHECKLISTS_DIR, basename);
      const original = fs.existsSync(target)
        ? fs.readFileSync(target, 'utf8')
        : null;
      if (original !== content) drifted.push(relChecklist(basename));
    }
    if (drifted.length === 0 && strays.length === 0) {
      Logger.info(
        `generate-lens-checklists: ${expected.size} checklist(s) up to date.`,
      );
      return;
    }
    const problems = [
      ...drifted.map((p) => `out of date: ${p}`),
      ...strays.map((s) => `stray (no lens): ${relChecklist(s)}`),
    ];
    throw new Error(
      `Lens checklists are out of sync:\n  ${problems.join('\n  ')}\n` +
        'Run `node .agents/scripts/generate-lens-checklists.js` to regenerate.',
    );
  }

  fs.mkdirSync(CHECKLISTS_DIR, { recursive: true });
  let wrote = 0;
  for (const [basename, content] of expected) {
    const target = path.join(CHECKLISTS_DIR, basename);
    const original = fs.existsSync(target)
      ? fs.readFileSync(target, 'utf8')
      : null;
    if (original === content) continue;
    fs.writeFileSync(target, content, 'utf8');
    wrote += 1;
  }
  for (const stray of strays) {
    fs.rmSync(path.join(CHECKLISTS_DIR, stray));
    Logger.info(
      `generate-lens-checklists: pruned stray ${relChecklist(stray)}`,
    );
  }
  Logger.info(
    `generate-lens-checklists: wrote ${wrote} of ${expected.size} checklist(s) (${strays.length} pruned).`,
  );
}

export { CHECKLISTS_DIR, WORKFLOWS_DIR };

runAsCli(import.meta.url, main, { source: 'generate-lens-checklists' });
