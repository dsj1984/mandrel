/**
 * Legacy-deletions spec (Epic #1181 / Story #1441 / Task #1455).
 *
 * Acceptance: the planning Skills migration retires
 *   - `.agents/scripts/epic-planner.js`       (replaced by epic-plan-spec.js)
 *   - `.agents/scripts/ticket-decomposer.js`  (inlined into epic-plan-decompose.js)
 *
 * This spec is a structural assertion that both files are absent AND that
 * no live consumer in `.agents/scripts/` or `tests/` still imports them
 * via `import ... from '<path>/(epic-planner|ticket-decomposer)(.js)?'`.
 *
 * Docs and baselines (CHANGELOG, audits, MI / coverage baselines) are
 * allowed to mention the retired files by name as breadcrumbs — those are
 * historical references, not runtime consumers.
 */

import assert from 'node:assert/strict';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..', '..');

const RETIRED_FILES = [
  '.agents/scripts/epic-planner.js',
  '.agents/scripts/ticket-decomposer.js',
];

const SCAN_ROOTS = [
  path.join(REPO_ROOT, '.agents', 'scripts'),
  path.join(REPO_ROOT, 'tests'),
];

const IMPORT_PATTERNS = [
  /from\s+['"][^'"\n]*epic-planner(?:\.js)?['"]/,
  /from\s+['"][^'"\n]*ticket-decomposer(?:\.js)?['"]/,
  /require\(\s*['"][^'"\n]*epic-planner(?:\.js)?['"]\s*\)/,
  /require\(\s*['"][^'"\n]*ticket-decomposer(?:\.js)?['"]\s*\)/,
];

async function fileExists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function* walkJsFiles(root) {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.worktrees') {
        continue;
      }
      yield* walkJsFiles(full);
      continue;
    }
    if (entry.isFile() && /\.(?:js|cjs|mjs)$/.test(entry.name)) {
      yield full;
    }
  }
}

describe('legacy-deletions — retired planning scripts', () => {
  it('removes .agents/scripts/epic-planner.js', async () => {
    const target = path.join(REPO_ROOT, RETIRED_FILES[0]);
    assert.equal(
      await fileExists(target),
      false,
      `${RETIRED_FILES[0]} must be deleted — its exports moved to epic-plan-spec.js`,
    );
  });

  it('removes .agents/scripts/ticket-decomposer.js', async () => {
    const target = path.join(REPO_ROOT, RETIRED_FILES[1]);
    assert.equal(
      await fileExists(target),
      false,
      `${RETIRED_FILES[1]} must be deleted — its engine was inlined into epic-plan-decompose.js`,
    );
  });

  it('no live consumer imports the retired modules', async () => {
    const offenders = [];
    for (const root of SCAN_ROOTS) {
      for await (const file of walkJsFiles(root)) {
        const source = await readFile(file, 'utf8');
        for (const pattern of IMPORT_PATTERNS) {
          if (pattern.test(source)) {
            offenders.push(`${path.relative(REPO_ROOT, file)} :: ${pattern}`);
          }
        }
      }
    }
    assert.deepEqual(
      offenders,
      [],
      `Found imports of retired modules:\n${offenders.join('\n')}`,
    );
  });
});
