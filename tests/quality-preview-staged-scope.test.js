import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { getStagedFiles, resolvePreviewScope } from '../.agents/scripts/lib/changed-files.js';

function git(cwd, ...args) {
  execSync(['git', ...args].join(' '), { cwd, stdio: 'pipe' });
}

function initRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'qp-staged-'));
  git(repo, 'init');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'user.name', 'Test');
  fs.writeFileSync(path.join(repo, 'base.txt'), 'base\n');
  git(repo, 'add', 'base.txt');
  git(repo, 'commit', '-m', 'init');
  return repo;
}

describe('quality-preview staged scope (git integration)', () => {
  it('staged-only: only index paths appear in staged scope', () => {
    const repo = initRepo();
    fs.writeFileSync(path.join(repo, 'staged-only.js'), 'export const a = 1;\n');
    fs.writeFileSync(path.join(repo, 'unstaged-only.js'), 'export const b = 2;\n');
    git(repo, 'add', 'staged-only.js');

    assert.deepEqual(getStagedFiles({ cwd: repo }), ['staged-only.js']);

    const scope = resolvePreviewScope({ staged: true, cwd: repo });
    assert.equal(scope.scope, 'staged');
    assert.deepEqual([...scope.scopeSet], ['staged-only.js']);
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it('unstaged-only: cached diff is empty when nothing is staged', () => {
    const repo = initRepo();
    fs.writeFileSync(path.join(repo, 'another-unstaged.js'), 'x\n');
    assert.deepEqual(getStagedFiles({ cwd: repo }), []);
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it('mixed staged and unstaged: staged scope excludes unstaged-only file', () => {
    const repo = initRepo();
    fs.writeFileSync(path.join(repo, 'mixed-staged.js'), 's\n');
    fs.writeFileSync(path.join(repo, 'mixed-unstaged.js'), 'u\n');
    git(repo, 'add', 'mixed-staged.js');
    fs.appendFileSync(path.join(repo, 'mixed-unstaged.js'), 'edit\n');

    const staged = new Set(getStagedFiles({ cwd: repo }));
    assert.ok(staged.has('mixed-staged.js'));
    assert.ok(!staged.has('mixed-unstaged.js'));

    const scope = resolvePreviewScope({ staged: true, cwd: repo });
    assert.equal(scope.scope, 'staged');
    assert.deepEqual([...scope.scopeSet], ['mixed-staged.js']);
    fs.rmSync(repo, { recursive: true, force: true });
  });
});
