/**
 * story-close-preflight.test.js — Unit tests for the preflight block
 * wired into `story-close.js` under Story #1289.
 *
 * The Story's acceptance criteria are:
 *   1. story-close.js exits with code 2 and prints a blocker-table
 *      (including fixCommand strings) when a blocker check fires.
 *   2. story-close.js exits with code 0 and proceeds normally when no
 *      blocker findings exist.
 *   3. The preflight block runs BEFORE any worktree-mutating call.
 *
 * The test drives the exported `runStoryClosePreflight` helper directly
 * with an inline fixture registry. The `runStoryClose` orchestrator pulls
 * `resolveCloseInputs` which hits the real provider / git env — out of
 * scope for a unit test. The "runs before any mutation" invariant is
 * proved structurally by source inspection (the preflight call site sits
 * BEFORE `withEpicMergeLock` in story-close.js, which is the first
 * mutating call); the source-position assertion below pins this so a
 * future refactor cannot silently move the preflight downstream.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runStoryClosePreflight } from '../.agents/scripts/story-close.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const STORY_CLOSE_PATH = path.resolve(
  __dirname,
  '..',
  '.agents',
  'scripts',
  'story-close.js',
);

/** Capture spy logger — records every level. */
function makeLogger() {
  const lines = { info: [], warn: [], error: [] };
  return {
    info: (...a) => lines.info.push(a.join(' ')),
    warn: (...a) => lines.warn.push(a.join(' ')),
    error: (...a) => lines.error.push(a.join(' ')),
    _lines: lines,
  };
}

const noopProbes = {
  git: () => ({ ok: true, stdout: '' }),
  fs: () => false,
  env: () => 'missing',
  lock: () => ({ exists: false }),
  pidLiveness: () => false,
};

describe('runStoryClosePreflight', () => {
  it('refuses with ok:false when a blocker check fires; blocker table includes fixCommand', async () => {
    const logger = makeLogger();
    const blockerCheck = {
      id: 'fixture-story-close-blocker',
      severity: 'blocker',
      scope: ['story-close'],
      autoCorrect: 'refuse-and-print',
      detect() {
        return {
          id: 'fixture-story-close-blocker',
          severity: 'blocker',
          scope: 'story-close',
          summary: 'fixture story-close blocker',
          fixCommand: 'echo fix-story-close',
          autoCorrectable: false,
        };
      },
    };
    const result = await runStoryClosePreflight({
      storyId: 1289,
      probes: noopProbes,
      registry: [blockerCheck],
      logger,
    });
    assert.equal(result.ok, false);
    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0].id, 'fixture-story-close-blocker');
    const stderr = logger._lines.error.join('\n');
    assert.match(stderr, /fixture-story-close-blocker/);
    assert.match(stderr, /echo fix-story-close/);
    assert.match(stderr, /exit 2/);
  });

  it('passes with ok:true when no findings exist', async () => {
    const logger = makeLogger();
    const result = await runStoryClosePreflight({
      storyId: 1289,
      probes: noopProbes,
      registry: [],
      logger,
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.findings, []);
    assert.deepEqual(result.fixed, []);
  });

  it('auto-fix routes the finding into fixed[] and does not block', async () => {
    const logger = makeLogger();
    let fixCalls = 0;
    const autoCheck = {
      id: 'fixture-story-close-auto',
      severity: 'warning',
      scope: ['story-close'],
      autoCorrect: 'auto',
      detect() {
        return {
          id: 'fixture-story-close-auto',
          severity: 'warning',
          scope: 'story-close',
          summary: 'fixture auto-fix',
          fixCommand: 'echo nope',
          autoCorrectable: true,
        };
      },
      fix() {
        fixCalls += 1;
        return { ok: true, message: 'auto-fixed' };
      },
    };
    const result = await runStoryClosePreflight({
      storyId: 1289,
      probes: noopProbes,
      registry: [autoCheck],
      logger,
    });
    assert.equal(result.ok, true);
    assert.equal(result.findings.length, 0);
    assert.equal(result.fixed.length, 1);
    assert.equal(fixCalls, 1);
  });
});

describe('story-close.js preflight position (source-level invariant)', () => {
  it('runs preflight BEFORE the worktree-mutating withEpicMergeLock call', () => {
    // Acceptance #3 — preflight must run before any mutation. The first
    // mutation in runStoryClose is `withEpicMergeLock(...)` (it writes a
    // lock file to .git/). Assert the preflight call site appears earlier
    // in the source than the lock acquisition so a future refactor that
    // reorders these is caught loudly.
    const src = readFileSync(STORY_CLOSE_PATH, 'utf8');
    const preflightIdx = src.indexOf(
      'runStoryClosePreflight({ storyId, cwd })',
    );
    const lockIdx = src.search(/withEpicMergeLock\(\n\s+epicId/);
    assert.ok(
      preflightIdx > 0,
      'preflight call site must exist in story-close.js',
    );
    assert.ok(lockIdx > 0, 'withEpicMergeLock call site must exist');
    assert.ok(
      preflightIdx < lockIdx,
      `preflight (idx=${preflightIdx}) must precede withEpicMergeLock (idx=${lockIdx})`,
    );
  });
});
