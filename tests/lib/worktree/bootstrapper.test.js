import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { copyBootstrapFiles } from '../../../.agents/scripts/lib/worktree/bootstrapper.js';

function makeRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bootstrap-'));
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

test('copyBootstrapFiles: copies .env when present in repoRoot and missing in worktree', () => {
  const root = makeRepo();
  fs.writeFileSync(path.join(root, '.env'), 'FOO=bar\n');
  const wt = path.join(root, 'wt');
  fs.mkdirSync(wt);
  const { logger } = quietLogger();
  copyBootstrapFiles(
    { repoRoot: root, config: { bootstrapFiles: ['.env'] }, logger },
    wt,
  );
  assert.equal(fs.readFileSync(path.join(wt, '.env'), 'utf8'), 'FOO=bar\n');
});

test('copyBootstrapFiles: preserves existing worktree file (no overwrite)', () => {
  const root = makeRepo();
  fs.writeFileSync(path.join(root, '.env'), 'FROM=root\n');
  const wt = path.join(root, 'wt');
  fs.mkdirSync(wt);
  fs.writeFileSync(path.join(wt, '.env'), 'FROM=worktree\n');
  const { logger } = quietLogger();
  copyBootstrapFiles(
    { repoRoot: root, config: { bootstrapFiles: ['.env'] }, logger },
    wt,
  );
  assert.equal(
    fs.readFileSync(path.join(wt, '.env'), 'utf8'),
    'FROM=worktree\n',
  );
});

test('copyBootstrapFiles: rejects traversal names', () => {
  const root = makeRepo();
  const wt = path.join(root, 'wt');
  fs.mkdirSync(wt);
  const { logger, sink } = quietLogger();
  copyBootstrapFiles(
    {
      repoRoot: root,
      config: { bootstrapFiles: ['../escape', '/abs/path'] },
      logger,
    },
    wt,
  );
  assert.ok(sink.warn.some((m) => m.includes('skipped invalid name')));
});

test('copyBootstrapFiles: skips missing source files silently', () => {
  const root = makeRepo();
  const wt = path.join(root, 'wt');
  fs.mkdirSync(wt);
  const { logger, sink } = quietLogger();
  copyBootstrapFiles(
    { repoRoot: root, config: { bootstrapFiles: ['.env'] }, logger },
    wt,
  );
  assert.equal(sink.warn.length, 0);
  assert.equal(fs.existsSync(path.join(wt, '.env')), false);
});
