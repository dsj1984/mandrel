import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import exec, {
  createGh,
  GhExecError,
  GhExecTimeoutError,
  getSpawnCount,
  prSurfaceUsesRest,
  prTransportOf,
  resetSpawnCount,
  runGh,
  setGraphqlAvailability,
} from '../../.agents/scripts/lib/gh-exec.js';
import { makeTempDir } from '../../.agents/scripts/lib/test-temp.js';

/**
 * Build a fake `spawn` that drives the EventEmitter-shaped child the
 * production code listens on. The fake captures the args/opts it was called
 * with so assertions can verify "no shell, args as array".
 */
function makeFakeSpawn({
  stdout = '',
  stderr = '',
  code = 0,
  signal = null,
} = {}) {
  const calls = [];
  const fake = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { end: () => {} };
    // Emit asynchronously so the production code can register listeners.
    queueMicrotask(() => {
      if (stdout) child.stdout.emit('data', Buffer.from(stdout, 'utf8'));
      if (stderr) child.stderr.emit('data', Buffer.from(stderr, 'utf8'));
      child.emit('close', code, signal);
    });
    return child;
  };
  return { fake, calls };
}

describe('gh-exec — JSON parse-through', () => {
  it('parses stdout as JSON when --json is in args', async () => {
    const payload = { number: 42, title: 'hello' };
    const { fake, calls } = makeFakeSpawn({
      stdout: JSON.stringify(payload),
    });
    const result = await exec({
      args: ['issue', 'view', '42', '--json', 'number,title'],
      spawnImpl: fake,
    });
    assert.deepEqual(result, payload);
    // Args passed as an array, no shell.
    assert.equal(calls.length, 1);
    assert.equal(calls[0].cmd, 'gh');
    assert.ok(Array.isArray(calls[0].args));
    assert.equal(calls[0].opts.shell, false);
  });

  it('returns raw {stdout,stderr,code} when --json is absent', async () => {
    const { fake } = makeFakeSpawn({ stdout: 'plain text\n', code: 0 });
    const result = await exec({
      args: ['auth', 'status'],
      spawnImpl: fake,
    });
    assert.equal(result.stdout, 'plain text\n');
    assert.equal(result.stderr, '');
    assert.equal(result.code, 0);
  });

  it('wraps JSON parse failures in GhExecError', async () => {
    const { fake } = makeFakeSpawn({ stdout: 'not json' });
    await assert.rejects(
      exec({
        args: ['issue', 'view', '1', '--json', 'number'],
        spawnImpl: fake,
      }),
      (err) => err instanceof GhExecError && /not valid JSON/.test(err.message),
    );
  });
});

describe('gh-exec — argument shape guard', () => {
  it('rejects when args is not an array', async () => {
    await assert.rejects(
      exec({ args: 'issue view 1', spawnImpl: () => {} }),
      (err) =>
        err instanceof GhExecError && /must be an array/.test(err.message),
    );
  });
});

describe('gh-exec — timeout surfacing', () => {
  it('rejects with GhExecTimeoutError when child is killed by spawn timeout', async () => {
    // Simulate Node's spawn-timeout behavior: code=null, signal='SIGTERM'.
    const { fake } = makeFakeSpawn({ code: null, signal: 'SIGTERM' });
    await assert.rejects(
      exec({
        args: ['repo', 'view', '--json', 'name'],
        timeoutMs: 50,
        spawnImpl: fake,
      }),
      (err) =>
        err instanceof GhExecTimeoutError &&
        err.timeoutMs === 50 &&
        /exceeded 50ms/.test(err.message),
    );
  });
});

describe('gh-exec — throw-away spawn counter (Story #1795)', () => {
  it('increments getSpawnCount on every successful spawn', async () => {
    resetSpawnCount();
    assert.equal(getSpawnCount(), 0);
    const { fake } = makeFakeSpawn({ stdout: '{"x":1}', code: 0 });
    await exec({
      args: ['issue', 'view', '1', '--json', 'x'],
      spawnImpl: fake,
    });
    assert.equal(getSpawnCount(), 1);
    await exec({
      args: ['issue', 'view', '2', '--json', 'x'],
      spawnImpl: fake,
    });
    assert.equal(getSpawnCount(), 2);
  });

  it('counts spawn attempts even when the child errors', async () => {
    resetSpawnCount();
    const { fake } = makeFakeSpawn({ stderr: 'boom', code: 1 });
    await assert.rejects(exec({ args: ['repo', 'view'], spawnImpl: fake }));
    assert.equal(getSpawnCount(), 1);
  });

  it('resetSpawnCount returns the counter to zero', async () => {
    const { fake } = makeFakeSpawn({ stdout: '', code: 0 });
    await exec({ args: ['auth', 'status'], spawnImpl: fake });
    assert.ok(getSpawnCount() >= 1);
    resetSpawnCount();
    assert.equal(getSpawnCount(), 0);
  });
});

describe('runGh captures through child-exec (Story #5756)', () => {
  const MIB = 1024 * 1024;
  const BIG = 'x'.repeat(2 * MIB);

  /** A `spawnSync`-shaped fake that fails ENOBUFS past its `maxBuffer`. */
  function bufferHonouringRunner(stdout) {
    const calls = [];
    const runner = (file, args, opts) => {
      calls.push({ file, args, opts });
      const limit = opts.maxBuffer ?? MIB;
      if (stdout.length > limit) {
        const error = Object.assign(new Error('spawnSync gh ENOBUFS'), {
          code: 'ENOBUFS',
        });
        return { status: null, stdout: stdout.slice(0, limit), error };
      }
      return { status: 0, stdout, stderr: '' };
    };
    return { runner, calls };
  }

  it('an injected runner receives the call under the shared ceiling', () => {
    const { runner, calls } = bufferHonouringRunner(BIG);
    const result = runGh(['api', 'big'], { cwd: '/repo' }, runner);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].file, 'gh');
    assert.deepEqual(calls[0].args, ['api', 'big']);
    assert.equal(calls[0].opts.cwd, '/repo');
    assert.equal(calls[0].opts.shell, false);
    assert.ok(calls[0].opts.maxBuffer > 1 * MIB);
    assert.equal(result.error, undefined);
    assert.equal(result.stdout.length, BIG.length);
  });

  it('a caller cannot reset the ceiling through its options', () => {
    const { runner, calls } = bufferHonouringRunner(BIG);
    runGh(['api', 'big'], { maxBuffer: MIB }, runner);
    assert.ok(calls[0].opts.maxBuffer >= MIB);
  });

  it('reads a gh child output larger than 1 MiB in full by default', {
    skip: process.platform === 'win32' && 'needs a POSIX gh stub on PATH',
  }, () => {
    const bin = makeTempDir('mandrel-rungh-big-');
    try {
      const stub = path.join(bin, 'gh');
      fs.writeFileSync(
        stub,
        `#!/bin/sh\nexec "${process.execPath}" -e "process.stdout.write('x'.repeat(${BIG.length}))"\n`,
      );
      fs.chmodSync(stub, 0o755);
      const env = {
        ...process.env,
        PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      };
      const result = runGh(['api', 'big'], { env });
      assert.equal(result.error, undefined);
      assert.equal(result.status, 0);
      assert.equal(result.stdout.length, BIG.length);
    } finally {
      fs.rmSync(bin, { recursive: true, force: true });
    }
  });
});

/**
 * Story #5793 — the GraphQL-availability latch and the `pr` transport it
 * selects. Every case clears the process-wide latch it set.
 */
describe('gh-exec — PR transport latch (Story #5793)', () => {
  afterEach(() => setGraphqlAvailability(null));

  /** A recording exec answering every `gh api` with `answer(args)`. */
  function recordingExec(answer = () => ({ stdout: '{}' })) {
    const argvs = [];
    const execImpl = async ({ args }) => {
      argvs.push(args);
      if (args[0] !== 'api')
        return args.includes('--json') ? [] : { stdout: '' };
      const value = answer(args);
      if (value instanceof Error) throw value;
      return { stderr: '', code: 0, ...value };
    };
    return { argvs, execImpl };
  }

  /** Every `pr` call the close path makes, with the argv `gh` gets today. */
  const CLOSE_PATH_CALLS = [
    [
      (gh) =>
        gh.pr.list(
          ['--head', 'story-1', '--state', 'all'],
          ['url', 'state', 'mergedAt'],
        ),
      [
        'pr',
        'list',
        '--head',
        'story-1',
        '--state',
        'all',
        '--json',
        'url,state,mergedAt',
      ],
    ],
    [
      (gh) =>
        gh.pr.create([
          '--base',
          'main',
          '--head',
          'story-1',
          '--title',
          't',
          '--body',
          'b',
        ]),
      [
        'pr',
        'create',
        '--base',
        'main',
        '--head',
        'story-1',
        '--title',
        't',
        '--body',
        'b',
      ],
    ],
    [
      (gh) => gh.pr.view(9, ['mergeStateStatus', 'statusCheckRollup']),
      ['pr', 'view', '9', '--json', 'mergeStateStatus,statusCheckRollup'],
    ],
    [
      (gh) => gh.pr.merge('9', ['--auto', '--squash', '--delete-branch']),
      ['pr', 'merge', '9', '--auto', '--squash', '--delete-branch'],
    ],
    [
      (gh) => gh.pr.merge('9', ['--disable-auto']),
      ['pr', 'merge', '9', '--disable-auto'],
    ],
    [(gh) => gh.pr.updateBranch(9), ['pr', 'update-branch', '9']],
    [
      (gh) => gh.pr.edit(9, ['--title', 't']),
      ['pr', 'edit', '9', '--title', 't'],
    ],
  ];

  // AC-4 — a GraphQL-reachable session issues byte-identical argv.
  for (const verdict of [null, 'available', 'auth-failed']) {
    it(`keeps every close-path gh pr argv unchanged (latch=${verdict})`, async () => {
      if (verdict) setGraphqlAvailability({ verdict });
      const { argvs, execImpl } = recordingExec();
      const gh = createGh(execImpl);
      for (const [callIt] of CLOSE_PATH_CALLS) await callIt(gh);
      assert.deepEqual(
        argvs,
        CLOSE_PATH_CALLS.map(([, argv]) => argv),
      );
      assert.equal(await prTransportOf(gh), 'graphql');
      assert.equal(prSurfaceUsesRest(), false);
    });
  }

  it('routes the pr surface over REST once the latch reads unavailable', async () => {
    setGraphqlAvailability({ verdict: 'unavailable' });
    const { argvs, execImpl } = recordingExec(() => ({ stdout: '[]' }));
    const gh = createGh(execImpl);
    await gh.pr.list(['--head', 'story-1', '--state', 'all'], ['url']);
    assert.deepEqual(argvs, [
      [
        'api',
        '-X',
        'GET',
        'repos/{owner}/{repo}/pulls?head={owner}:story-1&state=all',
      ],
    ]);
    assert.equal(await prTransportOf(gh), 'rest');
    assert.equal(prSurfaceUsesRest(), true);
  });

  it('probes once on first use with lazyProbe, and memoizes the verdict', async () => {
    const { argvs, execImpl } = recordingExec((args) =>
      args[3] === 'graphql'
        ? new GhExecError('gh-exec: gh exited with code 1', {
            args,
            stderr:
              'gh: GitHub GraphQL is not available from Claude Code sessions (HTTP 403)',
            code: 1,
          })
        : { stdout: '[]' },
    );
    const gh = createGh(execImpl, {}, { lazyProbe: true });
    await gh.pr.list(['--head', 'story-1', '--state', 'all'], ['url']);
    await gh.pr.list(['--head', 'story-2', '--state', 'all'], ['url']);
    const probes = argvs.filter((a) => a[3] === 'graphql');
    assert.equal(probes.length, 1, 'the probe runs once per process');
    assert.ok(
      argvs.every((a) => a[0] === 'api'),
      'no gh pr subcommand spawned',
    );
    assert.equal(prSurfaceUsesRest(), true);
  });

  it('keeps GraphQL when the lazy probe answers', async () => {
    const { argvs, execImpl } = recordingExec(() => ({ stdout: '{}' }));
    const gh = createGh(execImpl, {}, { lazyProbe: true });
    await gh.pr.view(3, ['url']);
    assert.deepEqual(argvs.at(-1), ['pr', 'view', '3', '--json', 'url']);
    assert.equal(await prTransportOf(gh), 'graphql');
  });

  it('reads a facade without a transport as GraphQL', async () => {
    assert.equal(await prTransportOf({ pr: {} }), 'graphql');
    assert.equal(await prTransportOf(undefined), 'graphql');
  });
});
