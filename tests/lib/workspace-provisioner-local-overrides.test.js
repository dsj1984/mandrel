import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  DEFAULT_WORKSPACE_FILES,
  provision,
} from '../../.agents/scripts/lib/workspace-provisioner.js';

// Worktree-isolated delivery must inherit the operator's gitignored
// local-override files so the config resolver sees the real
// `github.operatorHandle` (and local instruction overrides) inside the
// worktree, not the committed `.agentrc.json` `@[USERNAME]` placeholder. The
// missing override previously broke single-story Story-lease release at close.

function makeRoots() {
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'wsp-lo-src-'));
  const dst = fs.mkdtempSync(path.join(os.tmpdir(), 'wsp-lo-dst-'));
  return { src, dst };
}

test('DEFAULT_WORKSPACE_FILES carries the local-override files', () => {
  assert.deepEqual(DEFAULT_WORKSPACE_FILES, [
    '.env',
    '.mcp.json',
    '.agentrc.local.json',
    '.agents/instructions.local.md',
  ]);
});

test('provision: copies the default workspace files into a fresh worktree', () => {
  const { src, dst } = makeRoots();
  fs.writeFileSync(path.join(src, '.env'), 'TOKEN=1\n');
  fs.writeFileSync(path.join(src, '.mcp.json'), '{"mcpServers":{}}\n');

  const result = provision({
    sourceRoot: src,
    targetWorktree: dst,
    files: ['.env', '.mcp.json'],
  });

  assert.deepEqual(result.copied.sort(), ['.env', '.mcp.json']);
  assert.equal(result.skipped.length, 0);
  assert.equal(result.missing.length, 0);
  assert.equal(fs.readFileSync(path.join(dst, '.env'), 'utf8'), 'TOKEN=1\n');
  assert.equal(
    fs.readFileSync(path.join(dst, '.mcp.json'), 'utf8'),
    '{"mcpServers":{}}\n',
  );
});

test('provision: copies local-override files into the worktree when present at source', () => {
  const { src, dst } = makeRoots();
  fs.writeFileSync(
    path.join(src, '.agentrc.local.json'),
    '{"github":{"operatorHandle":"@dsj1984"}}\n',
  );
  fs.mkdirSync(path.join(src, '.agents'), { recursive: true });
  fs.writeFileSync(path.join(src, '.agents', 'instructions.local.md'), '# x\n');

  const result = provision({
    sourceRoot: src,
    targetWorktree: dst,
    files: DEFAULT_WORKSPACE_FILES,
  });

  assert.ok(result.copied.includes('.agentrc.local.json'));
  assert.ok(
    result.copied.includes(path.normalize('.agents/instructions.local.md')),
  );
  assert.equal(
    fs.readFileSync(path.join(dst, '.agentrc.local.json'), 'utf8'),
    '{"github":{"operatorHandle":"@dsj1984"}}\n',
  );
});

test('provision: absent local-override files are reported missing, never fatal', () => {
  const { src, dst } = makeRoots();
  fs.writeFileSync(path.join(src, '.env'), 'TOKEN=1\n');

  const result = provision({
    sourceRoot: src,
    targetWorktree: dst,
    files: DEFAULT_WORKSPACE_FILES,
  });

  assert.deepEqual(result.copied, ['.env']);
  assert.deepEqual(result.missing.sort(), [
    '.agentrc.local.json',
    path.normalize('.agents/instructions.local.md'),
    '.mcp.json',
  ]);
});
