#!/usr/bin/env node
/**
 * Distils each `audit-<lens>.md` workflow into a committed write-time
 * checklist under `.agents/audit-checklists/`. The directory is a pure
 * function of its sources: strays are pruned (flagged under `--check`), and a
 * lens with no workflow is reported, never silently skipped.
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
 * @param {ReadonlyArray<string>} lenses
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
 * @returns {{
 *   expected: Map<string, string>,
 *   missing: string[],
 *   strays: string[],
 * }}
 */
export function buildExpected({
  fsImpl = fs,
  lenses = AUDIT_LENSES,
  workflowsDir = WORKFLOWS_DIR,
  checklistsDir = CHECKLISTS_DIR,
} = {}) {
  const workflowPath = (lens) => path.join(workflowsDir, `audit-${lens}.md`);
  const { expected, missing } = planChecklists(
    lenses,
    (lens) => fsImpl.existsSync(workflowPath(lens)),
    (lens) => fsImpl.readFileSync(workflowPath(lens), 'utf8'),
  );

  const onDisk = fsImpl.existsSync(checklistsDir)
    ? fsImpl.readdirSync(checklistsDir).filter((name) => name.endsWith('.md'))
    : [];
  const strays = onDisk.filter((name) => !expected.has(name));

  return { expected, missing, strays };
}

/**
 * @param {string} basename
 * @param {string} [checklistsDir]
 * @param {string} [projectRoot]
 * @returns {string}
 */
function relChecklist(
  basename,
  checklistsDir = CHECKLISTS_DIR,
  projectRoot = PROJECT_ROOT,
) {
  return path
    .relative(projectRoot, path.join(checklistsDir, basename))
    .split(path.sep)
    .join('/');
}

/**
 * @param {string[]} [argv]
 * @param {{
 *   fsImpl?: typeof fs,
 *   lenses?: ReadonlyArray<string>,
 *   workflowsDir?: string,
 *   checklistsDir?: string,
 *   projectRoot?: string,
 *   logger?: { info: Function },
 * }} [deps]
 * @returns {Promise<{ wrote: number, pruned: number, checked?: boolean }>}
 */
export async function runGenerateLensChecklists(
  argv = process.argv.slice(2),
  deps = {},
) {
  const {
    fsImpl = fs,
    lenses = AUDIT_LENSES,
    workflowsDir = WORKFLOWS_DIR,
    checklistsDir = CHECKLISTS_DIR,
    projectRoot = PROJECT_ROOT,
    logger = Logger,
  } = deps;
  const { values } = parseArgs({
    args: argv,
    options: { check: { type: 'boolean', default: false } },
    allowPositionals: false,
  });

  const { expected, missing, strays } = buildExpected({
    fsImpl,
    lenses,
    workflowsDir,
    checklistsDir,
  });
  const rel = (basename) => relChecklist(basename, checklistsDir, projectRoot);

  if (missing.length > 0) {
    logger.info(
      `generate-lens-checklists: no audit-<lens>.md for: ${missing.join(', ')} — no checklist emitted.`,
    );
  }

  if (values.check) {
    const drifted = [];
    for (const [basename, content] of expected) {
      const target = path.join(checklistsDir, basename);
      const original = fsImpl.existsSync(target)
        ? fsImpl.readFileSync(target, 'utf8')
        : null;
      if (original !== content) drifted.push(rel(basename));
    }
    if (drifted.length === 0 && strays.length === 0) {
      logger.info(
        `generate-lens-checklists: ${expected.size} checklist(s) up to date.`,
      );
      return { wrote: 0, pruned: 0, checked: true };
    }
    const problems = [
      ...drifted.map((p) => `out of date: ${p}`),
      ...strays.map((s) => `stray (no lens): ${rel(s)}`),
    ];
    throw new Error(
      `Lens checklists are out of sync:\n  ${problems.join('\n  ')}\n` +
        'Run `node .agents/scripts/generate-lens-checklists.js` to regenerate.',
    );
  }

  fsImpl.mkdirSync(checklistsDir, { recursive: true });
  let wrote = 0;
  for (const [basename, content] of expected) {
    const target = path.join(checklistsDir, basename);
    const original = fsImpl.existsSync(target)
      ? fsImpl.readFileSync(target, 'utf8')
      : null;
    if (original === content) continue;
    fsImpl.writeFileSync(target, content, 'utf8');
    wrote += 1;
  }
  for (const stray of strays) {
    fsImpl.rmSync(path.join(checklistsDir, stray));
    logger.info(`generate-lens-checklists: pruned stray ${rel(stray)}`);
  }
  logger.info(
    `generate-lens-checklists: wrote ${wrote} of ${expected.size} checklist(s) (${strays.length} pruned).`,
  );
  return { wrote, pruned: strays.length };
}

/**
 * @param {string[]} [argv]
 */
async function main(argv = process.argv.slice(2)) {
  await runGenerateLensChecklists(argv);
}

export { CHECKLISTS_DIR, WORKFLOWS_DIR };

runAsCli(import.meta.url, main, { source: 'generate-lens-checklists' });
