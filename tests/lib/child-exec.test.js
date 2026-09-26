/**
 * child-exec.test.js — the shared child-process surface (Story #5009).
 *
 * The bound is read off the runner's *recorded options*, never off the source
 * text: `assert.match(source, /maxBuffer/)` would pass against a ceiling still
 * below the output that killed the child, which is the bug this module exists
 * to end. The real-bytes acceptance leg lives in
 * `tests/lib/git-utils-maxbuffer.test.js`, which drives >1 MB of genuine git
 * output through `gitSync` / `gitSpawn` — both of which now route here.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  execFileCapture,
  execFileCaptureAsync,
  formatChildFailure,
  INTERCEPTOR_MAX_BUFFER_BYTES,
  spawnCapture,
  spawnCaptureAsync,
  spawnChild,
} from '../../.agents/scripts/lib/child-exec.js';

/**
 * The ceiling the wrapper must apply. Held here as an expectation rather than
 * imported: the constant is deliberately module-private, so a call site
 * cannot get the ceiling wrong by naming it, and the assertions below read it
 * off the runner's recorded options — behaviour, not syntax.
 */
const MAX_BUFFER_BYTES = 64 * 1024 * 1024;

/** Records what the wrapper handed the runner, and returns `value`. */
function recorder(value) {
  const calls = [];
  const run = (file, args, opts) => {
    calls.push({ file, args, opts });
    return typeof value === 'function' ? value() : value;
  };
  return { calls, run };
}

describe('the ceilings', () => {
  it('the default ceiling reaching the runner is 64 MiB', () => {
    const { calls, run } = recorder('');
    execFileCapture('git', ['status'], { run });
    assert.equal(calls[0].opts.maxBuffer, 67108864);
    assert.equal(calls[0].opts.maxBuffer, MAX_BUFFER_BYTES);
  });

  it('the interceptor bound stays at the 10 MiB it reports', () => {
    // diagnose-friction.js emits this number on the friction row and in its
    // remediation text; raising it would change emitted output, so it is a
    // deliberately separate constant rather than an oversight.
    assert.equal(INTERCEPTOR_MAX_BUFFER_BYTES, 10485760);
    assert.ok(INTERCEPTOR_MAX_BUFFER_BYTES < MAX_BUFFER_BYTES);
  });
});

describe('execFileCapture', () => {
  it('applies the ceiling, shell:false and utf8 by default', () => {
    const { calls, run } = recorder('out\n');
    const out = execFileCapture('git', ['status'], { run, cwd: '/repo' });
    assert.equal(out, 'out\n');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].file, 'git');
    assert.deepEqual(calls[0].args, ['status']);
    assert.equal(calls[0].opts.maxBuffer, MAX_BUFFER_BYTES);
    assert.equal(calls[0].opts.shell, false);
    assert.equal(calls[0].opts.encoding, 'utf8');
    assert.equal(calls[0].opts.cwd, '/repo');
  });

  it('passes caller options through without dropping the ceiling', () => {
    const { calls, run } = recorder('');
    execFileCapture('git', ['log'], {
      run,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { PATH: '/bin' },
    });
    assert.deepEqual(calls[0].opts.stdio, ['ignore', 'pipe', 'ignore']);
    assert.deepEqual(calls[0].opts.env, { PATH: '/bin' });
    assert.equal(calls[0].opts.maxBuffer, MAX_BUFFER_BYTES);
  });

  it('an explicit maxBuffer overrides the default', () => {
    const { calls, run } = recorder('');
    execFileCapture('node', ['-v'], {
      run,
      maxBuffer: INTERCEPTOR_MAX_BUFFER_BYTES,
    });
    assert.equal(calls[0].opts.maxBuffer, INTERCEPTOR_MAX_BUFFER_BYTES);
  });

  it('propagates a throwing runner — a non-zero exit stays the caller-owned', () => {
    assert.throws(
      () =>
        execFileCapture('git', ['nope'], {
          run: () => {
            throw new Error('exit 1');
          },
        }),
      /exit 1/,
    );
  });

  it('runs a real child when no runner is injected', () => {
    const out = execFileCapture(process.execPath, [
      '-e',
      "process.stdout.write('hi')",
    ]);
    assert.equal(String(out), 'hi');
  });
});

describe('execFileCaptureAsync', () => {
  it('applies the same policy on the async path', async () => {
    const { calls, run } = recorder(() =>
      Promise.resolve({ stdout: 'a\nb\n', stderr: '' }),
    );
    const { stdout } = await execFileCaptureAsync('git', ['diff'], {
      run,
      cwd: '/repo',
    });
    assert.equal(stdout, 'a\nb\n');
    assert.equal(calls[0].opts.maxBuffer, MAX_BUFFER_BYTES);
    assert.equal(calls[0].opts.shell, false);
    assert.equal(calls[0].opts.cwd, '/repo');
  });

  it('runs a real child when no runner is injected', async () => {
    const { stdout } = await execFileCaptureAsync(process.execPath, [
      '-e',
      "process.stdout.write('async')",
    ]);
    assert.equal(stdout, 'async');
  });

  it('rejects when the child fails', async () => {
    await assert.rejects(
      execFileCaptureAsync(process.execPath, ['-e', 'process.exit(3)']),
      /3/,
    );
  });
});

describe('spawnChild', () => {
  it('returns the runner result untouched', () => {
    const raw = {
      status: null,
      stdout: 'keep\n\n',
      stderr: '',
      signal: 'SIGTERM',
    };
    const { calls, run } = recorder(raw);
    const result = spawnChild('git', ['show', 'HEAD:x'], { run, cwd: '/repo' });
    assert.equal(
      result,
      raw,
      'callers that need status===null must still see it',
    );
    assert.equal(result.stdout, 'keep\n\n', 'stdout is not trimmed');
    assert.equal(calls[0].opts.maxBuffer, MAX_BUFFER_BYTES);
    assert.equal(calls[0].opts.stdio, 'pipe');
    assert.equal(calls[0].opts.encoding, 'utf-8');
    assert.equal(calls[0].opts.shell, false);
  });

  it('runs a real child when no runner is injected', () => {
    const result = spawnChild(process.execPath, [
      '-e',
      "process.stdout.write('raw')",
    ]);
    assert.equal(result.status, 0);
    assert.equal(result.stdout, 'raw');
  });
});

describe('spawnCapture', () => {
  it('trims both streams and preserves a numeric status', () => {
    const { run } = recorder({ status: 3, stdout: 'out\n', stderr: 'err\n' });
    assert.deepEqual(spawnCapture('git', ['status'], { run }), {
      status: 3,
      stdout: 'out',
      stderr: 'err',
    });
  });

  it('coerces a null status to 1 so no caller reads a kill as success', () => {
    const { run } = recorder({ status: null, stdout: null, stderr: null });
    assert.deepEqual(spawnCapture('git', ['status'], { run }), {
      status: 1,
      stdout: '',
      stderr: '',
    });
  });

  it('survives a runner that returns nothing at all', () => {
    const { run } = recorder(undefined);
    assert.deepEqual(spawnCapture('git', ['status'], { run }), {
      status: 1,
      stdout: '',
      stderr: '',
    });
  });

  it('coerces Buffer streams to trimmed strings', () => {
    const { run } = recorder({
      status: 0,
      stdout: Buffer.from(' buffered \n'),
      stderr: Buffer.from(''),
    });
    assert.deepEqual(spawnCapture('git', ['status'], { run }), {
      status: 0,
      stdout: 'buffered',
      stderr: '',
    });
  });
});

describe('formatChildFailure', () => {
  it('renders the label, the raw status and trimmed stderr', () => {
    assert.equal(
      formatChildFailure({
        label: 'readBaseFromGit: git show main:baselines/crap.json',
        status: 128,
        stderr: '  fatal: bad path\n',
      }),
      'readBaseFromGit: git show main:baselines/crap.json failed (status=128): fatal: bad path',
    );
  });

  it('renders a null status verbatim — that IS the diagnostic', () => {
    const message = formatChildFailure({ label: 'x', status: null });
    assert.match(message, /status=null/);
    assert.equal(message, 'x failed (status=null): ');
  });
});

describe('spawnCaptureAsync (Story #5480)', () => {
  const NODE = process.execPath;

  it('feeds stdin, trims output and normalises the status', async () => {
    const out = await spawnCaptureAsync(
      NODE,
      [
        '-e',
        "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{process.stdout.write('  '+d.toUpperCase()+'\\n');process.exit(3);});",
      ],
      { input: 'hello' },
    );
    assert.deepEqual(out, { status: 3, stdout: 'HELLO', stderr: '' });
  });

  it('kills a child that outlives its timeout and reports status 1', async () => {
    const out = await spawnCaptureAsync(
      NODE,
      ['-e', 'setTimeout(() => {}, 10_000)'],
      { timeout: 100 },
    );
    assert.equal(out.status, 1);
  });

  it('reports a missing binary as a failed result, never a rejection', async () => {
    const out = await spawnCaptureAsync('mandrel-no-such-binary-5480', []);
    assert.equal(out.status, 1);
    assert.match(out.stderr, /ENOENT/);
  });

  it('applies the ceiling and routes through an injected runner', async () => {
    let seen;
    const out = await spawnCaptureAsync('x', ['y'], {
      input: 'in',
      run: async (_file, _args, options) => {
        seen = options;
        return { status: null, stdout: ' a ', stderr: ' b ' };
      },
    });
    assert.equal(seen.maxBuffer, MAX_BUFFER_BYTES);
    assert.equal(seen.shell, false);
    assert.equal(seen.input, 'in');
    assert.deepEqual(out, { status: 1, stdout: 'a', stderr: 'b' });
  });

  it('leaves the event loop free: a concurrent child drains while it runs', async () => {
    const order = [];
    const slow = spawnCaptureAsync(NODE, [
      '-e',
      "setTimeout(() => process.stdout.write('done'), 600)",
    ]).then(() => order.push('slow'));
    // More than a pipe buffer: it only finishes if its output is drained.
    const chatty = spawnCaptureAsync(NODE, [
      '-e',
      "process.stdout.write('x'.repeat(512 * 1024))",
    ]).then((r) => {
      order.push('chatty');
      return r.stdout.length;
    });
    const [, chattyBytes] = await Promise.all([slow, chatty]);
    assert.equal(chattyBytes, 512 * 1024);
    assert.deepEqual(order, ['chatty', 'slow']);
  });
});
