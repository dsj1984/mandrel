import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  DEFAULT_WORKSPACE_FILES,
  provision,
  resolveWorkspaceFiles,
  verify,
} from '../../.agents/scripts/lib/workspace-provisioner.js';

function makeRoots() {
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'wsp-src-'));
  const dst = fs.mkdtempSync(path.join(os.tmpdir(), 'wsp-dst-'));
  return { src, dst };
}

function quietLogger() {
  const sink = { info: [], warn: [], error: [] };
  return {
    sink,
    logger: {
      info: (m) => sink.info.push(m),
      warn: (m) => sink.warn.push(m),
      error: (m) => sink.error.push(m),
    },
  };
}

test('DEFAULT_WORKSPACE_FILES is [.env, .mcp.json]', () => {
  assert.deepEqual(DEFAULT_WORKSPACE_FILES, ['.env', '.mcp.json']);
});

test('resolveWorkspaceFiles: prefers workspaceFiles', () => {
  const files = resolveWorkspaceFiles({
    workspaceFiles: ['.env', '.custom'],
    worktreeIsolation: { bootstrapFiles: ['.legacy'] },
  });
  assert.deepEqual(files, ['.env', '.custom']);
});

test('resolveWorkspaceFiles: falls back to legacy bootstrapFiles', () => {
  const files = resolveWorkspaceFiles({
    worktreeIsolation: { bootstrapFiles: ['.env', '.mcp.json', '.extra'] },
  });
  assert.deepEqual(files, ['.env', '.mcp.json', '.extra']);
});

test('resolveWorkspaceFiles: defaults when unset', () => {
  assert.deepEqual(resolveWorkspaceFiles(undefined), DEFAULT_WORKSPACE_FILES);
  assert.deepEqual(resolveWorkspaceFiles({}), DEFAULT_WORKSPACE_FILES);
});

test('provision: copies .env and .mcp.json into a fresh worktree by default', () => {
  const { src, dst } = makeRoots();
  fs.writeFileSync(path.join(src, '.env'), 'TOKEN=1\n');
  fs.writeFileSync(path.join(src, '.mcp.json'), '{"mcpServers":{}}\n');
  const { logger } = quietLogger();

  const result = provision({
    sourceRoot: src,
    targetWorktree: dst,
    logger,
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

test('provision: preserves existing target files (no overwrite)', () => {
  const { src, dst } = makeRoots();
  fs.writeFileSync(path.join(src, '.env'), 'FROM=src\n');
  fs.writeFileSync(path.join(dst, '.env'), 'FROM=worktree\n');
  const { logger } = quietLogger();

  const result = provision({
    sourceRoot: src,
    targetWorktree: dst,
    files: ['.env'],
    logger,
  });

  assert.deepEqual(result.skipped, ['.env']);
  assert.equal(result.copied.length, 0);
  assert.equal(
    fs.readFileSync(path.join(dst, '.env'), 'utf8'),
    'FROM=worktree\n',
  );
});

test('provision: reports missing sources without warning', () => {
  const { src, dst } = makeRoots();
  const { logger, sink } = quietLogger();
  const result = provision({
    sourceRoot: src,
    targetWorktree: dst,
    files: ['.env', '.mcp.json'],
    logger,
  });
  assert.deepEqual(result.missing.sort(), ['.env', '.mcp.json']);
  assert.equal(result.copied.length, 0);
  assert.equal(sink.warn.length, 0);
});

test('provision: rejects traversal and absolute names', () => {
  const { src, dst } = makeRoots();
  fs.writeFileSync(path.join(src, '.env'), 'OK=1\n');
  const { logger, sink } = quietLogger();
  provision({
    sourceRoot: src,
    targetWorktree: dst,
    files: ['../escape', '/abs/path', '.env'],
    logger,
  });
  assert.equal(fs.existsSync(path.join(dst, '.env')), true);
  assert.ok(sink.warn.some((m) => m.includes('skipped invalid name')));
});

test('provision: empty or missing files list is a no-op', () => {
  const { src, dst } = makeRoots();
  const { logger } = quietLogger();
  const r1 = provision({
    sourceRoot: src,
    targetWorktree: dst,
    files: [],
    logger,
  });
  assert.deepEqual(r1, { copied: [], skipped: [], missing: [] });
});

test('provision: throws when sourceRoot or targetWorktree missing', () => {
  assert.throws(() => provision({ targetWorktree: '/tmp/x' }), /sourceRoot/);
  assert.throws(() => provision({ sourceRoot: '/tmp/x' }), /targetWorktree/);
});

test('verify: throws when a required file is missing', () => {
  const { dst } = makeRoots();
  fs.writeFileSync(path.join(dst, '.env'), 'X=1\n');
  assert.throws(
    () => verify({ worktree: dst, files: ['.env', '.mcp.json'] }),
    /missing.*\.mcp\.json/,
  );
});

test('verify: passes when all required files are present', () => {
  const { dst } = makeRoots();
  fs.writeFileSync(path.join(dst, '.env'), 'X=1\n');
  fs.writeFileSync(path.join(dst, '.mcp.json'), '{}\n');
  verify({ worktree: dst, files: ['.env', '.mcp.json'] });
});

test('verify: error surfaces the missing absolute path', () => {
  const { dst } = makeRoots();
  let caught;
  try {
    verify({ worktree: dst, files: ['.mcp.json'] });
  } catch (err) {
    caught = err;
  }
  assert.ok(caught, 'verify should throw when .mcp.json is missing');
  const expectedAbs = path.join(dst, '.mcp.json');
  assert.ok(
    caught.message.includes(expectedAbs),
    `error should include absolute missing path (${expectedAbs}); got: ${caught.message}`,
  );
});

test('verify: when sourceRoot is supplied, error includes remediation command', () => {
  const { src, dst } = makeRoots();
  fs.writeFileSync(path.join(src, '.env'), 'A=1\n');
  let caught;
  try {
    verify({ worktree: dst, files: ['.env'], sourceRoot: src });
  } catch (err) {
    caught = err;
  }
  assert.ok(caught, 'verify should throw when .env is missing from worktree');
  assert.match(caught.message, /remediation:/);
  assert.ok(
    caught.message.includes(path.join(src, '.env')),
    'error should reference the source path for remediation',
  );
  assert.ok(
    caught.message.includes(path.join(dst, '.env')),
    'error should reference the target path for remediation',
  );
});

test('verify: reports every missing file, not just the first', () => {
  const { dst } = makeRoots();
  let caught;
  try {
    verify({ worktree: dst, files: ['.env', '.mcp.json'] });
  } catch (err) {
    caught = err;
  }
  assert.ok(caught);
  assert.match(caught.message, /\.env/);
  assert.match(caught.message, /\.mcp\.json/);
});
