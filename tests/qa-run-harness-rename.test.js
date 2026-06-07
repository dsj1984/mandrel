/**
 * qa-run-harness rename guard (Epic #3686 / Story #3719).
 *
 * Acceptance: the `run-qa-harness` workflow/command is hard-cutover renamed to
 * `qa-run-harness` (no alias), establishing the `qa-*` workflow family
 * (f7-qa-naming). This spec is a structural assertion that:
 *
 *   1. `.agents/workflows/qa-run-harness.md` exists and
 *      `.agents/workflows/run-qa-harness.md` does not.
 *   2. `.claude/commands/qa-run-harness.md` exists and
 *      `.claude/commands/run-qa-harness.md` does not. The `.claude/commands/`
 *      tree is generated from `.agents/workflows/` by `sync-claude-commands.js`,
 *      which prunes orphans — so the old generated command disappears once the
 *      source workflow is renamed and the sync re-runs.
 *   3. No file under `.agents/`, `docs/`, `.claude/`, or `tests/` references the
 *      old `run-qa-harness` string (this test file excepted).
 *
 * The skill DIRECTORY `.agents/skills/stack/qa/qa-harness/` keeps its name —
 * only the workflow/command string `run-qa-harness` is renamed, so the
 * directory name never matches the `run-qa-harness` reference pattern.
 */

import assert from 'node:assert/strict';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

const NEW_WORKFLOW = '.agents/workflows/qa-run-harness.md';
const OLD_WORKFLOW = '.agents/workflows/run-qa-harness.md';
const NEW_COMMAND = '.claude/commands/qa-run-harness.md';
const OLD_COMMAND = '.claude/commands/run-qa-harness.md';

const SCAN_ROOTS = [
  path.join(REPO_ROOT, '.agents'),
  path.join(REPO_ROOT, 'docs'),
  path.join(REPO_ROOT, '.claude'),
  path.join(REPO_ROOT, 'tests'),
];

// Directories that hold historical breadcrumbs, generated mirrors, or
// installed dependencies — none of which are live consumers.
const EXCLUDED_DIRS = new Set(['node_modules', '.worktrees', 'archive']);

// The old name, as a string. Constructed at runtime so this test file is not
// itself an offender when it scans for the pattern.
const OLD_REFERENCE = ['run', 'qa', 'harness'].join('-');
const SELF = path.join(REPO_ROOT, 'tests', 'qa-run-harness-rename.test.js');

async function fileExists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function* walkTextFiles(root) {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRS.has(entry.name)) continue;
      yield* walkTextFiles(full);
      continue;
    }
    if (entry.isFile()) {
      yield full;
    }
  }
}

describe('qa-run-harness rename guard', () => {
  it('renames the workflow to .agents/workflows/qa-run-harness.md', async () => {
    assert.equal(
      await fileExists(path.join(REPO_ROOT, NEW_WORKFLOW)),
      true,
      `${NEW_WORKFLOW} must exist`,
    );
    assert.equal(
      await fileExists(path.join(REPO_ROOT, OLD_WORKFLOW)),
      false,
      `${OLD_WORKFLOW} must be deleted — its successor is ${NEW_WORKFLOW}`,
    );
  });

  it('renames the generated command to .claude/commands/qa-run-harness.md', async () => {
    assert.equal(
      await fileExists(path.join(REPO_ROOT, NEW_COMMAND)),
      true,
      `${NEW_COMMAND} must exist — re-run \`npm run sync:commands\``,
    );
    assert.equal(
      await fileExists(path.join(REPO_ROOT, OLD_COMMAND)),
      false,
      `${OLD_COMMAND} must be absent — re-run \`npm run sync:commands\` to prune the orphaned generated command`,
    );
  });

  it('no live .agents/, docs/, .claude/, or tests/ file references the old run-qa-harness name', async () => {
    const offenders = [];
    for (const root of SCAN_ROOTS) {
      for await (const file of walkTextFiles(root)) {
        if (file === SELF) continue;
        let source;
        try {
          source = await readFile(file, 'utf8');
        } catch {
          continue;
        }
        if (source.includes(OLD_REFERENCE)) {
          offenders.push(path.relative(REPO_ROOT, file));
        }
      }
    }
    assert.deepEqual(
      offenders,
      [],
      `Found live references to the old /run-qa-harness name (repoint to /qa-run-harness):\n${offenders.join('\n')}`,
    );
  });
});
