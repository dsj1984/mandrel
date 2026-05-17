// tests/lib/orchestration/lifecycle/runner-retirement.test.js
/**
 * Contract test for the retirement of the legacy deliver-runner CLI
 * wrapper (Story #2259 / Task #2264, Epic #2172).
 *
 * The wrapper was dry-run-only after Wave 6 and emitted a hard error
 * in non-dry-run mode. Story #2259 deletes it outright; the
 * `/epic-deliver` slash command (driving the lifecycle bus listener
 * chain) is the sole entry point for Epic delivery from this Story
 * forward.
 *
 * Acceptance contract:
 *   - The wrapper file MUST NOT exist on disk.
 *   - `git grep` for the legacy filename literal MUST return zero
 *     matches across the repository. This is the High-3 review
 *     finding from the independent review: the runner / docs /
 *     workflow phase-ownership drift is closed when no reference
 *     to the retired entry point survives.
 *
 * The grep contract is enforced via a JS-native scan rather than
 * shelling out to `git`, so the test is robust to git absence in CI
 * containers and to platform path-separator quirks. The scan walks
 * the tracked-tree at `PROJECT_ROOT` (the worktree root) using
 * `node:fs` and stops at the universal ignore set (node_modules,
 * .git, .worktrees, baselines, package-lock.json) which are not part
 * of the framework's authored surface.
 */

import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..', '..');

const LEGACY_RUNNER_PATH = path.join(
  PROJECT_ROOT,
  '.agents',
  'scripts',
  'epic-deliver-runner.js',
);

const FORBIDDEN_LITERAL = 'epic-deliver-runner';

/**
 * Universal ignore set: directories and files that are not part of
 * the authored framework surface (third-party deps, git internals,
 * worktree-scoped scratch, generated baselines, lockfiles, and this
 * test file itself which necessarily carries the literal it is
 * scanning for).
 */
const IGNORE_DIRS = new Set([
  'node_modules',
  '.git',
  '.worktrees',
  'temp',
  'coverage',
]);

const IGNORE_FILES = new Set([
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml',
]);

/**
 * Walk the project tree and yield absolute paths of every text-ish
 * file we care to scan. We exclude binary file extensions so the
 * search is cheap; ripgrep / git grep do the same.
 */
function* walkRepo(root) {
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch (err) {
    if (err && err.code === 'ENOENT') return;
    throw err;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (IGNORE_DIRS.has(entry.name)) continue;
      if (
        entry.name.startsWith('.') &&
        entry.name !== '.agents' &&
        entry.name !== '.github' &&
        entry.name !== '.husky' &&
        entry.name !== '.claude'
      ) {
        // Skip dotfile directories we don't author (e.g. .vscode,
        // .changeset). The framework-owned dotfile dirs are
        // explicitly allowed above.
        continue;
      }
      yield* walkRepo(path.join(root, entry.name));
      continue;
    }
    if (!entry.isFile()) continue;
    if (IGNORE_FILES.has(entry.name)) continue;
    yield path.join(root, entry.name);
  }
}

/**
 * Self-exemption: this test file necessarily carries the literal so
 * it can assert against it. We skip ourselves during the scan.
 */
const SELF_PATH = fileURLToPath(import.meta.url);

describe('Deliver-runner CLI retirement (Task #2264)', () => {
  it('the legacy wrapper file does not exist on disk', () => {
    assert.equal(
      existsSync(LEGACY_RUNNER_PATH),
      false,
      `${LEGACY_RUNNER_PATH} must be deleted (Story #2259).`,
    );
  });

  it('no source file references the legacy filename literal', () => {
    const hits = [];
    for (const file of walkRepo(PROJECT_ROOT)) {
      if (file === SELF_PATH) continue;
      let content;
      try {
        // Skip files we cannot read as utf-8 text (very large /
        // binary). A binary file with the legacy literal would be a
        // surprise but is not a meaningful violation.
        const stats = statSync(file);
        if (stats.size > 2 * 1024 * 1024) continue;
        content = readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      if (content.includes(FORBIDDEN_LITERAL)) {
        hits.push(path.relative(PROJECT_ROOT, file));
      }
    }
    assert.deepEqual(
      hits,
      [],
      `Found stale references to '${FORBIDDEN_LITERAL}' in:\n  ${hits.join('\n  ')}\n` +
        '/epic-deliver is the sole entry point — these files must be updated.',
    );
  });

  it('/epic-deliver slash command remains the documented entry point', () => {
    const docPath = path.join(
      PROJECT_ROOT,
      '.agents',
      'workflows',
      'epic-deliver.md',
    );
    assert.equal(
      existsSync(docPath),
      true,
      'epic-deliver workflow markdown must remain on disk.',
    );
  });
});
