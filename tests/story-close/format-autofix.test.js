import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { runFormatAutofix } from '../../.agents/scripts/lib/orchestration/story-close/format-autofix.js';

function makeLogger() {
  const logs = { info: [], warn: [] };
  return {
    logs,
    info: (msg) => logs.info.push(msg),
    warn: (msg) => logs.warn.push(msg),
  };
}

function makeGitStub({ statusBefore, statusAfter, headSha = 'abcdefg' }) {
  const state = { biomeRan: false };
  const calls = [];
  return {
    calls,
    state,
    git(args /*, _opts */) {
      calls.push(args);
      if (args[0] === 'status') {
        return state.biomeRan ? statusAfter : statusBefore;
      }
      if (args[0] === 'rev-parse') return `${headSha}\n`;
      // add / commit are side-effect-only in the stub.
      return '';
    },
  };
}

/**
 * Build a spawnSync stub that flips the git stub's `biomeRan` flag the
 * first time `npx biome format --write` is invoked, so the second
 * `git status` call sees `statusAfter`.
 */
function makeBiomeSpawn(state, { fail = false } = {}) {
  return (cmd, args /*, _opts */) => {
    if (cmd === 'npx' && args[0] === 'biome' && args.includes('--write')) {
      state.biomeRan = true;
      if (fail) {
        const err = new Error('biome blew up');
        err.status = 2;
        throw err;
      }
    }
    return '';
  };
}

describe('runFormatAutofix', () => {
  it('skips when the working tree is dirty before the autofix runs', () => {
    const logger = makeLogger();
    const gitStub = makeGitStub({
      statusBefore: ' M src/foo.js\n',
      statusAfter: ' M src/foo.js\n',
    });
    const spawn = makeBiomeSpawn(gitStub.state);
    const result = runFormatAutofix({
      cwd: '/tmp/repo',
      storyId: 1234,
      logger,
      spawnSync: spawn,
      gitSync: gitStub.git,
    });
    assert.equal(result.ran, false);
    assert.equal(result.committed, false);
    assert.deepEqual(result.dirtyPathsBefore, ['src/foo.js']);
    assert.match(logger.logs.info[0], /skipped — working tree dirty/);
    // No add/commit happened.
    assert.equal(
      gitStub.calls.some((args) => args[0] === 'commit'),
      false,
    );
  });

  it('runs biome and reports clean tree when no drift exists', () => {
    const logger = makeLogger();
    const gitStub = makeGitStub({ statusBefore: '', statusAfter: '' });
    const spawn = makeBiomeSpawn(gitStub.state);
    const result = runFormatAutofix({
      cwd: '/tmp/repo',
      storyId: 7,
      logger,
      spawnSync: spawn,
      gitSync: gitStub.git,
    });
    assert.equal(gitStub.state.biomeRan, true);
    assert.equal(result.ran, true);
    assert.equal(result.committed, false);
    assert.match(logger.logs.info[0], /no format drift/);
  });

  it('commits a style: fixup when biome rewrites files', () => {
    const logger = makeLogger();
    const gitStub = makeGitStub({
      statusBefore: '',
      statusAfter: ' M .agents/schemas/foo.json\n M .agents/schemas/bar.json\n',
      headSha: 'deadbee',
    });
    const spawn = makeBiomeSpawn(gitStub.state);
    const result = runFormatAutofix({
      cwd: '/tmp/repo',
      storyId: 42,
      logger,
      spawnSync: spawn,
      gitSync: gitStub.git,
    });
    assert.equal(result.ran, true);
    assert.equal(result.committed, true);
    assert.equal(result.sha, 'deadbee');
    // Verify the commit subject names the storyId.
    const commitCall = gitStub.calls.find((args) => args[0] === 'commit');
    assert.ok(commitCall, 'commit was invoked');
    const subject = commitCall[2];
    assert.match(
      subject,
      /^style: biome format autofix on story-close \(story #42\)$/,
    );
    assert.match(logger.logs.info[0], /healed 2 path\(s\)/);
  });

  it('does not throw when biome --write itself errors; lets the gate report drift', () => {
    const logger = makeLogger();
    const gitStub = makeGitStub({ statusBefore: '', statusAfter: '' });
    const spawn = makeBiomeSpawn(gitStub.state, { fail: true });
    const result = runFormatAutofix({
      cwd: '/tmp/repo',
      storyId: 9,
      logger,
      spawnSync: spawn,
      gitSync: gitStub.git,
    });
    assert.equal(result.ran, true);
    assert.equal(result.committed, false);
    assert.match(logger.logs.warn[0], /exited non-zero/);
  });

  it('honours agentSettings.commands.formatWrite when configured', () => {
    const logger = makeLogger();
    const gitStub = makeGitStub({ statusBefore: '', statusAfter: '' });
    const spawnCalls = [];
    const spawn = (cmd, args /*, _opts */) => {
      spawnCalls.push({ cmd, args });
      // Mark "ran" so the second status check returns the after-state.
      gitStub.state.biomeRan = true;
      return '';
    };
    const result = runFormatAutofix({
      cwd: '/tmp/repo',
      storyId: 11,
      settings: {
        commands: { formatWrite: 'pnpm exec prettier --write .' },
      },
      logger,
      spawnSync: spawn,
      gitSync: gitStub.git,
    });
    assert.equal(result.ran, true);
    assert.equal(result.committed, false);
    // The configured prettier invocation, not the biome default.
    assert.deepEqual(spawnCalls[0], {
      cmd: 'pnpm',
      args: ['exec', 'prettier', '--write', '.'],
    });
  });
});
