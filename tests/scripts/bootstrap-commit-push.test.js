/**
 * bootstrap-commit-push.test — Story #3899, Finding A.6.
 *
 * Covers the end-of-bootstrap "commit + push the wiring" offer:
 *
 *   - the pure path/instruction helpers in `lib/bootstrap/commit-push.js`
 *     (allowlist resolution, secret exclusion, manual-command rendering),
 *   - the `offerCommitPush` phase in `bootstrap.js` via an injected `runGit`
 *     seam (no real git spawned):
 *       · accept  → git add + commit + push invoked,
 *       · decline → instructions printed, NO git mutation,
 *       · non-interactive (--assume-yes) → instructions printed, NO mutation,
 *       · --dry-run → no-op,
 *       · secrets (.env / .mcp.json / .agentrc.local.json) are never staged.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

import { offerCommitPush } from '../../.agents/scripts/bootstrap.js';
import {
  BOOTSTRAP_COMMIT_PATHS,
  buildManualInstructions,
  COMMIT_SUBJECT,
  NEVER_STAGE_PATHS,
  resolveStagePaths,
  stageBootstrapFiles,
} from '../../.agents/scripts/lib/bootstrap/commit-push.js';
import { Logger } from '../../.agents/scripts/lib/Logger.js';

const ANSWERS = Object.freeze({
  owner: 'acme',
  repo: 'widget',
  baseBranch: 'main',
  operatorHandle: 'octo',
});

const tmpDirs = [];

function makeTmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bootstrap-cp-'));
  tmpDirs.push(dir);
  return dir;
}

/** Seed a subset of the allowlist as real files in `dir`. */
function seed(dir, rels) {
  for (const rel of rels) {
    const target = path.join(dir, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, 'x', 'utf8');
  }
}

/** A spying `runGit` seam that records calls and returns a scripted result. */
function makeRunGit(results = {}) {
  const calls = [];
  const runGit = (args, cwd) => {
    calls.push({ args, cwd });
    const verb = args.find((a) => !a.startsWith('-') || a === '-A') ?? '';
    // Find the git subcommand (commit/push/add) ignoring -c identity pairs.
    const sub = args.includes('commit')
      ? 'commit'
      : args.includes('push')
        ? 'push'
        : args.includes('add')
          ? 'add'
          : verb;
    const scripted = results[sub];
    return scripted ?? { ok: true, status: 0, stdout: '', stderr: '' };
  };
  return { runGit, calls };
}

beforeEach(() => {
  mock.method(Logger, 'info', () => {});
  mock.method(Logger, 'warn', () => {});
});

afterEach(() => {
  mock.reset();
  while (tmpDirs.length > 0) {
    fs.rmSync(tmpDirs.pop(), { recursive: true, force: true });
  }
});

describe('resolveStagePaths — allowlist + secret exclusion', () => {
  it('returns only the allowlist files that exist on disk', () => {
    const dir = makeTmpDir();
    seed(dir, ['.agentrc.json', 'CLAUDE.md', 'package.json']);
    const resolved = resolveStagePaths(dir);
    assert.deepEqual(resolved.sort(), [
      '.agentrc.json',
      'CLAUDE.md',
      'package.json',
    ]);
  });

  it('never resolves secret/local paths even when present on disk', () => {
    const dir = makeTmpDir();
    seed(dir, ['.agentrc.json', '.env', '.mcp.json', '.agentrc.local.json']);
    const resolved = resolveStagePaths(dir);
    for (const secret of NEVER_STAGE_PATHS) {
      assert.ok(!resolved.includes(secret), `${secret} must not be staged`);
    }
    assert.ok(resolved.includes('.agentrc.json'));
  });

  it('returns [] when none of the allowlist files exist', () => {
    const dir = makeTmpDir();
    assert.deepEqual(resolveStagePaths(dir), []);
  });
});

describe('buildManualInstructions', () => {
  it('renders the exact add/commit/push command block with the resolved paths', () => {
    const text = buildManualInstructions({
      stagePaths: ['.agents', '.agentrc.json'],
      baseBranch: 'develop',
    });
    assert.match(text, /git add \.agents \.agentrc\.json/);
    assert.match(text, new RegExp(`git commit -m "${COMMIT_SUBJECT}"`));
    assert.match(text, /git push -u origin develop/);
    // Never advertises `git add -A` (which could stage a secret).
    assert.ok(!/git add -A/.test(text));
  });

  it('falls back to `git add .` only when no paths resolve', () => {
    const text = buildManualInstructions({
      stagePaths: [],
      baseBranch: 'main',
    });
    assert.match(text, /git add \./);
  });
});

describe('stageBootstrapFiles', () => {
  it('stages the resolved allowlist via `git add -- <paths>` and never -A', () => {
    const dir = makeTmpDir();
    seed(dir, ['.agentrc.json', 'package.json', '.env']);
    const { runGit, calls } = makeRunGit();
    const res = stageBootstrapFiles({ projectRoot: dir, runGit });
    assert.equal(res.ok, true);
    assert.ok(res.staged.includes('.agentrc.json'));
    assert.ok(!res.staged.includes('.env'));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].args[0], 'add');
    assert.equal(calls[0].args[1], '--');
    assert.ok(!calls[0].args.includes('.env'));
    assert.ok(!calls[0].args.includes('-A'));
  });

  it('is a no-op (no git call) when nothing resolves', () => {
    const dir = makeTmpDir();
    const { runGit, calls } = makeRunGit();
    const res = stageBootstrapFiles({ projectRoot: dir, runGit });
    assert.deepEqual(res, { ok: true, staged: [] });
    assert.equal(calls.length, 0);
  });
});

describe('offerCommitPush phase', () => {
  function baseState(dir, overrides = {}) {
    return {
      projectRoot: dir,
      answers: { ...ANSWERS },
      flags: {},
      interactive: true,
      ...overrides,
    };
  }

  it('accept → stages, commits, and pushes the base branch', async () => {
    const dir = makeTmpDir();
    seed(dir, ['.agents/scripts/x.js', '.agentrc.json', 'CLAUDE.md']);
    const { runGit, calls } = makeRunGit();
    const res = await offerCommitPush(baseState(dir), {
      runGit,
      confirm: async () => true,
    });
    assert.equal(res.ok, true);
    assert.equal(res.payload.commitPush.action, 'committed-pushed');
    const subcommands = calls.map((c) =>
      c.args.includes('commit')
        ? 'commit'
        : c.args.includes('push')
          ? 'push'
          : c.args.includes('add')
            ? 'add'
            : '?',
    );
    assert.deepEqual(subcommands, ['add', 'commit', 'push']);
    const pushCall = calls.find((c) => c.args.includes('push'));
    assert.deepEqual(pushCall.args, ['push', '-u', 'origin', 'main']);
  });

  it('decline → prints instructions and performs NO git mutation', async () => {
    const dir = makeTmpDir();
    seed(dir, ['.agentrc.json']);
    const { runGit, calls } = makeRunGit();
    const res = await offerCommitPush(baseState(dir), {
      runGit,
      confirm: async () => false,
    });
    assert.equal(res.ok, true);
    assert.equal(res.payload.commitPush.action, 'declined');
    assert.equal(calls.length, 0);
  });

  it('non-interactive (--assume-yes) → instructions printed, NO mutation', async () => {
    const dir = makeTmpDir();
    seed(dir, ['.agentrc.json']);
    const { runGit, calls } = makeRunGit();
    const res = await offerCommitPush(
      baseState(dir, { interactive: false, assumeYes: true }),
      { runGit },
    );
    assert.equal(res.ok, true);
    assert.equal(res.payload.commitPush.action, 'instructed');
    assert.equal(calls.length, 0);
  });

  it('--dry-run → no-op (no prompt, no git)', async () => {
    const dir = makeTmpDir();
    const { runGit, calls } = makeRunGit();
    const res = await offerCommitPush(
      baseState(dir, { flags: { 'dry-run': true } }),
      { runGit },
    );
    assert.deepEqual(res, { ok: true, payload: {} });
    assert.equal(calls.length, 0);
  });

  it('push failure is non-fatal and surfaces a push-failed action', async () => {
    const dir = makeTmpDir();
    seed(dir, ['.agentrc.json']);
    const { runGit } = makeRunGit({
      push: { ok: false, status: 1, stdout: '', stderr: 'rejected' },
    });
    const res = await offerCommitPush(baseState(dir), {
      runGit,
      confirm: async () => true,
    });
    assert.equal(res.ok, true);
    assert.equal(res.payload.commitPush.action, 'push-failed');
  });

  it('the allowlist excludes the generated .claude/commands tree', () => {
    assert.ok(!BOOTSTRAP_COMMIT_PATHS.includes('.claude/commands'));
    assert.ok(BOOTSTRAP_COMMIT_PATHS.includes('.agents'));
  });
});
