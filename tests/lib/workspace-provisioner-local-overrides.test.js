import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { WORKTREE_ISOLATION_DEFAULTS } from '../../.agents/scripts/lib/config/worktree-isolation.js';
import { makeTempDir } from '../../.agents/scripts/lib/test-temp.js';
import {
  DEFAULT_WORKSPACE_FILES,
  provision,
} from '../../.agents/scripts/lib/workspace-provisioner.js';

// Worktree-isolated delivery inherits the operator's gitignored files. The
// `.agentrc.local.json` overlay is not among them: a worktree reads the main
// checkout's live copy, so an init-time snapshot would only go stale.

function makeRoots() {
  const src = makeTempDir('wsp-lo-src-');
  const dst = makeTempDir('wsp-lo-dst-');
  return { src, dst };
}

test('DEFAULT_WORKSPACE_FILES carries the local files but no overlay snapshot', () => {
  assert.deepEqual(DEFAULT_WORKSPACE_FILES, [
    '.env',
    '.mcp.json',
    '.agents/instructions.local.md',
  ]);
  assert.deepEqual(
    [...WORKTREE_ISOLATION_DEFAULTS.bootstrapFiles],
    DEFAULT_WORKSPACE_FILES,
  );
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

test('provision: copies the overlay only when the workspace files list it explicitly', () => {
  const { src, dst } = makeRoots();
  fs.writeFileSync(
    path.join(src, '.agentrc.local.json'),
    '{"github":{"operatorHandle":"@dsj1984"}}\n',
  );
  fs.mkdirSync(path.join(src, '.agents'), { recursive: true });
  fs.writeFileSync(path.join(src, '.agents', 'instructions.local.md'), '# x\n');

  const defaults = provision({
    sourceRoot: src,
    targetWorktree: dst,
    files: DEFAULT_WORKSPACE_FILES,
  });
  assert.ok(!defaults.copied.includes('.agentrc.local.json'));
  assert.equal(fs.existsSync(path.join(dst, '.agentrc.local.json')), false);
  assert.ok(
    defaults.copied.includes(path.normalize('.agents/instructions.local.md')),
  );

  const result = provision({
    sourceRoot: src,
    targetWorktree: dst,
    files: [...DEFAULT_WORKSPACE_FILES, '.agentrc.local.json'],
  });

  assert.ok(result.copied.includes('.agentrc.local.json'));
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
    path.normalize('.agents/instructions.local.md'),
    '.mcp.json',
  ]);
});
