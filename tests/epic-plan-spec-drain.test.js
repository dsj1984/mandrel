import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { drainPendingCleanupAtBoot } from '../.agents/scripts/epic-plan-spec.js';
import {
  MAX_SWEEP_ATTEMPTS,
  manifestPath,
  readManifest,
  recordPendingCleanup,
} from '../.agents/scripts/lib/worktree/lifecycle/pending-cleanup.js';

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

function tmpRepo() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sps-drain-'));
  fs.mkdirSync(path.join(tmp, '.worktrees'), { recursive: true });
  return tmp;
}

test('drainPendingCleanupAtBoot: no-op when manifest is absent', async () => {
  const repoRoot = tmpRepo();
  try {
    const { logger, sink } = quietLogger();
    const stubGit = { gitSpawn: () => ({ status: 0, stdout: '', stderr: '' }) };
    const result = await drainPendingCleanupAtBoot({
      repoRoot,
      git: stubGit,
      logger,
    });
    assert.deepEqual(result.drained, []);
    assert.equal(result.remaining, 0);
    assert.equal(sink.info.length, 0, 'no log line when manifest is empty');
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('drainPendingCleanupAtBoot: drains a seeded manifest entry when stage-1 retry succeeds', async () => {
  const repoRoot = tmpRepo();
  const worktreeRoot = path.join(repoRoot, '.worktrees');
  try {
    const wtPath = path.join(worktreeRoot, 'story-777');
    fs.mkdirSync(wtPath, { recursive: true });
    recordPendingCleanup(worktreeRoot, {
      storyId: 777,
      branch: 'story-777',
      path: wtPath,
    });
    assert.equal(readManifest(worktreeRoot).length, 1);

    const { logger, sink } = quietLogger();
    const stubGit = {
      gitSpawn: () => ({ status: 0, stdout: '', stderr: '' }),
    };
    const result = await drainPendingCleanupAtBoot({
      repoRoot,
      git: stubGit,
      logger,
    });
    assert.deepEqual(result.drained, [777]);
    assert.equal(result.remaining, 0);
    assert.equal(
      fs.existsSync(manifestPath(worktreeRoot)),
      false,
      'manifest removed after full drain',
    );
    assert.ok(
      sink.info.some((m) => m.includes('reaped=1')),
      `expected reaped=1 log line, got: ${sink.info.join(' | ')}`,
    );
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('drainPendingCleanupAtBoot: persistent entries do not block, remaining count logged', async () => {
  const repoRoot = tmpRepo();
  const worktreeRoot = path.join(repoRoot, '.worktrees');
  try {
    const wtPath = path.join(worktreeRoot, 'story-888');
    fs.mkdirSync(wtPath, { recursive: true });
    const seeded = {
      storyId: 888,
      branch: 'story-888',
      path: wtPath,
      push: false,
      firstFailedAt: new Date().toISOString(),
      lastFailedAt: new Date().toISOString(),
      attempts: MAX_SWEEP_ATTEMPTS,
    };
    fs.writeFileSync(
      manifestPath(worktreeRoot),
      `${JSON.stringify([seeded], null, 2)}\n`,
    );

    const { logger, sink } = quietLogger();
    const stubGit = {
      gitSpawn: () => ({ status: 0, stdout: '', stderr: '' }),
    };
    const fsRm = async () => {
      const err = new Error('EBUSY: resource locked');
      err.code = 'EBUSY';
      throw err;
    };
    const result = await drainPendingCleanupAtBoot({
      repoRoot,
      git: stubGit,
      fsRm,
      logger,
    });
    assert.equal(result.drained.length, 0);
    assert.ok(result.remaining >= 1, 'persistent entry counted in remaining');
    assert.ok(
      sink.info.some((m) => m.includes('remaining=')),
      'logs a remaining= count',
    );
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});
