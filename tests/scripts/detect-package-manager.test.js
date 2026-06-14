/**
 * Unit tests for the shared lockfile-probe helper (Story #4048 B3).
 *
 * Prior to this story, several independent `detectPackageManager`
 * implementations existed across the codebase with subtly different semantics:
 *
 *   - `lib/cli/update.js`              → returns { packageManager, workspaceRoot }
 *   - `lib/bootstrap/project-bootstrap.js` → returns 'pnpm'|'yarn'|'npm'
 *   - `lib/runtime-deps/preflight.js`  → returns 'pnpm'|'yarn'|'npm'
 *   - `lib/worktree/node-modules-strategy.js` (inline probe)
 *
 * This suite exercises the unified `detectPackageManager` and
 * `detectPackageManagerWithWorkspace` functions and covers the edge cases that
 * previously diverged:
 *
 *   - When no manifest exists at all, some copies defaulted to `'npm'`; the
 *     shared helper returns `null`.
 *   - The shared helper detects `bun` from `bun.lockb` (some copies did not).
 *   - `update.js` needed `workspaceRoot`; the others did not.
 *     `detectPackageManagerWithWorkspace` provides that.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

const { detectPackageManager, detectPackageManagerWithWorkspace } =
  await import(
    pathToFileURL(
      path.join(ROOT, '.agents', 'scripts', 'lib', 'detect-package-manager.js'),
    ).href
  );

/**
 * Build a fake `exists` function that reports only the given basenames.
 * Mirrors the in-memory fixtures used by the individual caller tests.
 */
function makeExists(present = []) {
  const set = new Set(present.map((f) => path.basename(f)));
  return (p) => set.has(path.basename(p));
}

describe('detectPackageManager', () => {
  it('detects pnpm from pnpm-lock.yaml', () => {
    assert.equal(
      detectPackageManager('/root', makeExists(['pnpm-lock.yaml'])),
      'pnpm',
    );
  });

  it('detects yarn from yarn.lock', () => {
    assert.equal(
      detectPackageManager('/root', makeExists(['yarn.lock'])),
      'yarn',
    );
  });

  it('detects bun from bun.lockb (strictest unified semantics)', () => {
    assert.equal(
      detectPackageManager('/root', makeExists(['bun.lockb'])),
      'bun',
    );
  });

  it('detects npm from package-lock.json', () => {
    assert.equal(
      detectPackageManager('/root', makeExists(['package-lock.json'])),
      'npm',
    );
  });

  it('returns npm when only package.json exists and no lockfile', () => {
    assert.equal(
      detectPackageManager('/root', makeExists(['package.json'])),
      'npm',
    );
  });

  it('returns null when the directory has no Node manifest at all', () => {
    assert.equal(detectPackageManager('/root', makeExists([])), null);
  });

  it('prefers pnpm over yarn when both lockfiles exist', () => {
    assert.equal(
      detectPackageManager(
        '/root',
        makeExists(['pnpm-lock.yaml', 'yarn.lock']),
      ),
      'pnpm',
    );
  });

  it('prefers yarn over bun when both lockfiles exist', () => {
    assert.equal(
      detectPackageManager('/root', makeExists(['yarn.lock', 'bun.lockb'])),
      'yarn',
    );
  });

  it('prefers pnpm over package-lock.json', () => {
    assert.equal(
      detectPackageManager(
        '/root',
        makeExists(['pnpm-lock.yaml', 'package-lock.json']),
      ),
      'pnpm',
    );
  });
});

describe('detectPackageManagerWithWorkspace', () => {
  it('detects pnpm workspace root when pnpm-workspace.yaml is present', () => {
    const result = detectPackageManagerWithWorkspace(
      '/ws',
      makeExists(['pnpm-lock.yaml', 'pnpm-workspace.yaml']),
    );
    assert.deepEqual(result, { packageManager: 'pnpm', workspaceRoot: true });
  });

  it('detects pnpm without workspace when pnpm-workspace.yaml is absent', () => {
    const result = detectPackageManagerWithWorkspace(
      '/ws',
      makeExists(['pnpm-lock.yaml']),
    );
    assert.deepEqual(result, { packageManager: 'pnpm', workspaceRoot: false });
  });

  it('returns workspaceRoot=false for yarn', () => {
    const result = detectPackageManagerWithWorkspace(
      '/ws',
      makeExists(['yarn.lock']),
    );
    assert.deepEqual(result, { packageManager: 'yarn', workspaceRoot: false });
  });

  it('coerces null (no manifest) to npm with workspaceRoot=false', () => {
    const result = detectPackageManagerWithWorkspace('/ws', makeExists([]));
    assert.deepEqual(result, { packageManager: 'npm', workspaceRoot: false });
  });

  it('does not set workspaceRoot for bun', () => {
    const result = detectPackageManagerWithWorkspace(
      '/ws',
      makeExists(['bun.lockb']),
    );
    assert.deepEqual(result, { packageManager: 'bun', workspaceRoot: false });
  });
});
