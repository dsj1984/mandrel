/**
 * One `.agentrc.local.json` per machine: a linked worktree reads the main
 * checkout's live overlay, and every Mandrel overlay reader agrees.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { expectedClaudeAgents } from '../../../.agents/scripts/lib/claude/agents-projection.js';
import { applyLocalOverlay } from '../../../.agents/scripts/lib/config/agentrc-overlay.js';
import {
  overlayDivergence,
  overlayRoot,
} from '../../../.agents/scripts/lib/config/git-roots.js';
import { syncAgentrc } from '../../../.agents/scripts/lib/config/sync-agentrc.js';
import { resolveConfig } from '../../../.agents/scripts/lib/config-resolver.js';
import { ensureGhEnv } from '../../../.agents/scripts/lib/gh-env.js';
import { makeTempDir } from '../../../.agents/scripts/lib/test-temp.js';
import { runAgentsInSync } from '../../../lib/cli/doctor-checks/sync-parity.js';
import { runTestCreditPath } from '../../../lib/cli/doctor-checks/test-credit-path.js';

const LOCAL = '.agentrc.local.json';
const made = [];
after(() => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
});

function git(cwd, ...args) {
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
    cwd,
    stdio: 'ignore',
  });
}

const writeJson = (dir, file, value) =>
  fs.writeFileSync(path.join(dir, file), JSON.stringify(value));

const cap = (n) => ({ delivery: { deliverRunner: { concurrencyCap: n } } });

/** A main checkout (not realpath-ed) with one linked worktree. */
function makeCheckout({ mainOverlay, worktreeOverlay } = {}) {
  const main = makeTempDir('mandrel-ovl-main-');
  made.push(main);
  git(main, 'init', '-q');
  fs.writeFileSync(path.join(main, '.gitignore'), `${LOCAL}\ngh-store\n`);
  git(main, 'add', '.');
  git(main, 'commit', '-q', '-m', 'init');
  const worktree = path.join(main, '.worktrees', 'story-1');
  git(main, 'worktree', 'add', '-q', worktree);
  if (mainOverlay) writeJson(main, LOCAL, mainOverlay);
  if (worktreeOverlay) writeJson(worktree, LOCAL, worktreeOverlay);
  return { main, worktree };
}

const resolvedCap = (cwd) =>
  resolveConfig({ cwd, validate: false, bustCache: true }).raw.delivery
    .deliverRunner.concurrencyCap;

function captureStderr(fn) {
  const lines = [];
  const original = process.stderr.write;
  process.stderr.write = (chunk) => {
    lines.push(String(chunk));
    return true;
  };
  try {
    fn();
  } finally {
    process.stderr.write = original;
  }
  return lines.filter((l) => l.includes(LOCAL));
}

describe('overlay resolution from a linked worktree', () => {
  it('the main checkout overlay wins and a later edit there is seen live (AC-1)', () => {
    const { main, worktree } = makeCheckout({
      mainOverlay: cap(2),
      worktreeOverlay: cap(9),
    });
    captureStderr(() => assert.equal(resolvedCap(worktree), 2));
    writeJson(main, LOCAL, cap(5));
    assert.equal(resolvedCap(worktree), 5);
  });

  it('the worktree copy serves when the main checkout has none (AC-2)', () => {
    const { worktree } = makeCheckout({ worktreeOverlay: cap(7) });
    assert.equal(resolvedCap(worktree), 7);
    assert.equal(overlayRoot(worktree), worktree);
  });

  it('the main checkout, a nested project and a non-git dir read their own (AC-2)', () => {
    const { main } = makeCheckout({ mainOverlay: cap(3) });
    assert.equal(resolvedCap(main), 3);
    const nested = path.join(main, 'packages', 'app');
    fs.mkdirSync(nested, { recursive: true });
    writeJson(nested, LOCAL, cap(4));
    assert.equal(resolvedCap(nested), 4);
    const plain = makeTempDir('mandrel-ovl-plain-');
    made.push(plain);
    writeJson(plain, LOCAL, cap(6));
    assert.equal(resolvedCap(plain), 6);
  });
});

describe('every overlay reader agrees with the resolver (AC-3)', () => {
  it('applyLocalOverlay and the sync-agentrc check read the main overlay', () => {
    const { main, worktree } = makeCheckout({
      mainOverlay: cap(2),
      worktreeOverlay: cap(9),
    });
    const { effective, localPath } = applyLocalOverlay({
      fsImpl: fs,
      projectRoot: worktree,
      committed: {},
    });
    assert.equal(effective.delivery.deliverRunner.concurrencyCap, 2);
    assert.equal(
      fs.realpathSync.native(localPath),
      fs.realpathSync.native(path.join(main, LOCAL)),
    );
    writeJson(worktree, '.agentrc.json', {});
    const sync = syncAgentrc({ projectRoot: worktree });
    assert.equal(
      fs.realpathSync.native(sync.localPath),
      fs.realpathSync.native(localPath),
    );
  });

  it('the gh env uses the main overlay cliConfigDir', () => {
    const { main, worktree } = makeCheckout({
      mainOverlay: { github: { cliConfigDir: 'gh-store' } },
      worktreeOverlay: { github: { cliConfigDir: 'stale-store' } },
    });
    fs.mkdirSync(path.join(main, 'gh-store'));
    const dir = ensureGhEnv({ cwd: worktree, env: {} });
    assert.equal(
      fs.realpathSync.native(dir),
      fs.realpathSync.native(path.join(main, 'gh-store')),
    );
  });

  it('the agent projection and the sync-parity check use the main overlay', () => {
    const routing = (r) => ({ delivery: { routing: r } });
    const { worktree } = makeCheckout({
      mainOverlay: routing({
        roleScopedAgents: false,
        agentModels: { 'story-worker': 'haiku' },
      }),
      worktreeOverlay: routing({
        roleScopedAgents: true,
        agentModels: { 'story-worker': 'opus' },
      }),
    });
    const agents = path.join(worktree, '.agents', 'agents');
    fs.mkdirSync(agents, { recursive: true });
    fs.writeFileSync(
      path.join(agents, 'story-worker.md'),
      '---\nname: story-worker\n---\nbody\n',
    );
    const projected = expectedClaudeAgents({ projectRoot: worktree });
    assert.match(projected.get('story-worker.md'), /model: haiku/);
    const parity = runAgentsInSync({ projectRoot: worktree });
    assert.equal(parity.ok, true);
    assert.match(parity.detail, /roleScopedAgents is disabled/);
  });

  it('the test-credit-path check reads the main overlay test command', () => {
    const command = (c) => ({ project: { commands: { test: c } } });
    const { worktree } = makeCheckout({
      mainOverlay: command('make live-test'),
      worktreeOverlay: command('make stale-test'),
    });
    const { detail } = runTestCreditPath({ projectRoot: worktree });
    assert.match(detail, /make live-test/);
    assert.doesNotMatch(detail, /stale-test/);
  });
});

describe('the divergence warning (AC-4)', () => {
  it('a differing worktree copy warns once per root on stderr, naming both paths', () => {
    const { main, worktree } = makeCheckout({
      mainOverlay: cap(2),
      worktreeOverlay: cap(9),
    });
    const lines = captureStderr(() => {
      resolveConfig({ cwd: worktree, validate: false, bustCache: true });
      resolveConfig({ cwd: worktree, validate: false, bustCache: true });
    });
    assert.equal(lines.length, 1);
    const { worktreePath, mainPath } = overlayDivergence(worktree);
    assert.equal(worktreePath, path.join(worktree, LOCAL));
    assert.equal(
      fs.realpathSync.native(mainPath),
      fs.realpathSync.native(path.join(main, LOCAL)),
    );
    assert.ok(lines[0].includes(worktreePath) && lines[0].includes(mainPath));
    assert.match(lines[0], /main checkout's overlay is in force/);
  });

  it('identical copies (key order aside) and worktrees without a copy stay silent', () => {
    const same = makeCheckout({
      mainOverlay: { a: 1, b: { c: 2 } },
      worktreeOverlay: { b: { c: 2 }, a: 1 },
    });
    const none = makeCheckout({ mainOverlay: cap(2) });
    const lines = captureStderr(() => {
      resolveConfig({ cwd: same.worktree, validate: false, bustCache: true });
      resolveConfig({ cwd: none.worktree, validate: false, bustCache: true });
    });
    assert.deepEqual(lines, []);
    assert.equal(overlayDivergence(same.worktree), null);
    assert.equal(overlayDivergence(none.worktree), null);
  });

  it('an unparseable worktree copy counts as differing', () => {
    const { worktree } = makeCheckout({ mainOverlay: cap(2) });
    fs.writeFileSync(path.join(worktree, LOCAL), '{ not json');
    assert.notEqual(overlayDivergence(worktree), null);
  });
});
