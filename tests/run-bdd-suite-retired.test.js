/**
 * run-bdd-suite retirement guard (Epic #3214 / Story #3298).
 *
 * Acceptance: the headless `/run-bdd-suite` workflow is hard-cutover deleted
 * and every live reference is repointed to its agent-driven successor
 * `/run-qa-harness` (authored in Story #3297).
 *
 * This spec is a structural assertion that:
 *   1. `.agents/workflows/run-bdd-suite.md` no longer exists.
 *   2. `.claude/commands/run-bdd-suite.md` no longer exists. The
 *      `.claude/commands/` tree is generated from `.agents/workflows/` by
 *      `sync-claude-commands.js`, which prunes orphans — so the generated
 *      command disappears once the source workflow is deleted and the sync
 *      re-runs. The assertion tolerates the directory being absent (a fresh
 *      checkout that has not run the sync yet).
 *   3. No live `.agents/` or `docs/` file references `run-bdd-suite`.
 *
 * `docs/archive/` is excluded: archived CHANGELOG breadcrumbs are historical
 * references to the retired workflow, not live consumers.
 */

import assert from 'node:assert/strict';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

const RETIRED_WORKFLOW = '.agents/workflows/run-bdd-suite.md';
const RETIRED_COMMAND = '.claude/commands/run-bdd-suite.md';

const SCAN_ROOTS = [
  path.join(REPO_ROOT, '.agents'),
  path.join(REPO_ROOT, 'docs'),
];

// Directories that hold historical breadcrumbs, generated mirrors, or
// installed dependencies — none of which are live consumers.
const EXCLUDED_DIRS = new Set(['node_modules', '.worktrees', 'archive']);

const REFERENCE = /run-bdd-suite/;

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

describe('run-bdd-suite retirement guard', () => {
  it('removes .agents/workflows/run-bdd-suite.md', async () => {
    const target = path.join(REPO_ROOT, RETIRED_WORKFLOW);
    assert.equal(
      await fileExists(target),
      false,
      `${RETIRED_WORKFLOW} must be deleted — its successor is .agents/workflows/run-qa-harness.md`,
    );
  });

  it('removes .claude/commands/run-bdd-suite.md', async () => {
    const target = path.join(REPO_ROOT, RETIRED_COMMAND);
    assert.equal(
      await fileExists(target),
      false,
      `${RETIRED_COMMAND} must be absent — re-run \`npm run sync:commands\` to prune the orphaned generated command`,
    );
  });

  it('no live .agents/ or docs/ file references run-bdd-suite', async () => {
    const offenders = [];
    for (const root of SCAN_ROOTS) {
      for await (const file of walkTextFiles(root)) {
        let source;
        try {
          source = await readFile(file, 'utf8');
        } catch {
          continue;
        }
        if (REFERENCE.test(source)) {
          offenders.push(path.relative(REPO_ROOT, file));
        }
      }
    }
    assert.deepEqual(
      offenders,
      [],
      `Found live references to the retired /run-bdd-suite workflow (repoint to /run-qa-harness):\n${offenders.join('\n')}`,
    );
  });
});
