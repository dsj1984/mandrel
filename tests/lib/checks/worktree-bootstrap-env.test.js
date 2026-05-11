import assert from 'node:assert/strict';
import fs from 'node:fs';
import { afterEach, describe, it } from 'node:test';
import check from '../../../.agents/scripts/lib/checks/worktree-bootstrap-env.js';

/**
 * Tests for the `worktree-bootstrap-env` check (Task #1302 under Story
 * #1286). Drives `check.detect(state)` directly. The check consumes the
 * `fs.worktreeBootstrapStatus` projection from `state.js`; the disk-walk
 * itself is covered separately in state.test.js.
 *
 * Contract under test:
 *   1. Returns a Finding with severity 'warning' for each worktree missing
 *      either bootstrap file.
 *   2. Returns null when every active worktree has both files.
 *   3. Never reads the *contents* of `.env`. Verified by a spy on
 *      `fs.readFileSync` that asserts no `.env` path was passed to it.
 */

function makeState(status, overrides = {}) {
  return {
    scope: 'epic-deliver',
    cwd: '/repo',
    git: {},
    fs: { worktreeBootstrapStatus: status },
    env: {},
    ...overrides,
  };
}

describe('check: worktree-bootstrap-env', () => {
  it('exposes the expected contract metadata', () => {
    assert.equal(check.id, 'worktree-bootstrap-env');
    assert.equal(check.severity, 'warning');
    assert.equal(check.autoCorrect, 'refuse-and-print');
    assert.ok(check.scope.includes('epic-deliver'));
    assert.equal(typeof check.detect, 'function');
    assert.equal(check.fix, undefined);
  });

  it('returns null when no worktrees are present', () => {
    assert.equal(check.detect(makeState({})), null);
  });

  it('returns null when every worktree has both bootstrap files', () => {
    const status = {
      '/repo/.worktrees/story-1101': { dotEnv: true, dotMcp: true },
      '/repo/.worktrees/story-1102': { dotEnv: true, dotMcp: true },
    };
    assert.equal(check.detect(makeState(status)), null);
  });

  it('returns a Finding when one worktree is missing .env only', () => {
    const status = {
      '/repo/.worktrees/story-1101': { dotEnv: false, dotMcp: true },
    };
    const finding = check.detect(makeState(status));
    assert.ok(finding);
    assert.equal(finding.severity, 'warning');
    assert.equal(finding.id, 'worktree-bootstrap-env');
    assert.ok(finding.detail.includes('story-1101'));
    assert.ok(finding.detail.includes('.env'));
    assert.ok(!finding.detail.includes('.mcp.json'));
  });

  it('returns a Finding when one worktree is missing .mcp.json only', () => {
    const status = {
      '/repo/.worktrees/story-1102': { dotEnv: true, dotMcp: false },
    };
    const finding = check.detect(makeState(status));
    assert.ok(finding);
    assert.ok(finding.detail.includes('.mcp.json'));
    assert.ok(!finding.detail.includes('.env,'));
  });

  it('lists every missing-file worktree with severity warning', () => {
    const status = {
      '/repo/.worktrees/story-a': { dotEnv: false, dotMcp: false },
      '/repo/.worktrees/story-b': { dotEnv: true, dotMcp: true }, // healthy
      '/repo/.worktrees/story-c': { dotEnv: true, dotMcp: false },
    };
    const finding = check.detect(makeState(status));
    assert.ok(finding);
    assert.equal(finding.severity, 'warning');
    assert.ok(finding.summary.includes('2 worktree'));
    assert.ok(finding.detail.includes('/repo/.worktrees/story-a'));
    assert.ok(finding.detail.includes('/repo/.worktrees/story-c'));
    // Healthy worktree must not be listed.
    assert.ok(!finding.detail.includes('/repo/.worktrees/story-b'));
  });

  it('fixCommand prints a cp recipe for each missing file', () => {
    const status = {
      '/repo/.worktrees/story-a': { dotEnv: false, dotMcp: false },
    };
    const finding = check.detect(makeState(status));
    assert.ok(finding);
    assert.ok(
      finding.fixCommand.includes('cp ".env" "/repo/.worktrees/story-a/.env"'),
    );
    assert.ok(
      finding.fixCommand.includes(
        'cp ".mcp.json" "/repo/.worktrees/story-a/.mcp.json"',
      ),
    );
  });

  describe('privacy invariant', () => {
    const origReadFileSync = fs.readFileSync;
    const origReadFile = fs.readFile;
    const origPromisesReadFile = fs.promises?.readFile;

    afterEach(() => {
      fs.readFileSync = origReadFileSync;
      fs.readFile = origReadFile;
      if (fs.promises) fs.promises.readFile = origPromisesReadFile;
    });

    it('never reads .env (or any) file contents during detect()', () => {
      const reads = [];
      fs.readFileSync = (...args) => {
        reads.push(args[0]);
        return '';
      };
      fs.readFile = (...args) => {
        reads.push(args[0]);
        const cb = args[args.length - 1];
        if (typeof cb === 'function') cb(null, '');
      };
      if (fs.promises) {
        fs.promises.readFile = async (p) => {
          reads.push(p);
          return '';
        };
      }
      const status = {
        '/repo/.worktrees/story-a': { dotEnv: false, dotMcp: true },
        '/repo/.worktrees/story-b': { dotEnv: true, dotMcp: false },
      };
      const finding = check.detect(makeState(status));
      assert.ok(finding);
      // The check must not have touched fs.readFileSync at all. If it
      // had read `.env` (or any path), the spy would have captured it.
      assert.equal(
        reads.length,
        0,
        `detect() must not read any file contents (saw ${JSON.stringify(reads)})`,
      );
    });
  });
});
