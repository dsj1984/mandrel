/**
 * bootstrap/hitl-confirm — TTY vs non-TTY contract (Epic #1235 Story 5).
 *
 * Covers:
 *   - Non-TTY → returns false, writes the canonical abort message to
 *     stderr.
 *   - `opts.assume === 'yes'` → returns true, no I/O.
 *   - `opts.assume === 'no'`  → returns false, no I/O.
 *   - TTY + "y" answer → returns true.
 *   - TTY + "n" / empty answer → returns false (N is the default).
 */

import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { describe, it } from 'node:test';
import {
  ABORT_MESSAGE,
  confirm,
} from '../../.agents/scripts/lib/bootstrap/hitl-confirm.js';

function makeStdout() {
  const s = new PassThrough();
  s.chunks = [];
  s.on('data', (b) => s.chunks.push(b.toString('utf8')));
  return s;
}

describe('bootstrap/hitl-confirm', () => {
  it('non-TTY → returns false and writes the abort message to stderr', async () => {
    const stdout = makeStdout();
    const stderr = makeStdout();
    const stdin = new PassThrough();
    const result = await confirm(
      { summary: 'test diff', current: { a: 1 }, proposed: { a: 2 } },
      { stdout, stderr, stdin, isTTY: false },
    );
    assert.equal(result, false);
    const stderrStr = stderr.chunks.join('');
    assert.match(stderrStr, /aborting: no TTY available/);
    assert.equal(stderrStr.trim(), ABORT_MESSAGE);
  });

  it('opts.assume === "yes" short-circuits to true without touching streams', async () => {
    const stdout = makeStdout();
    const stderr = makeStdout();
    const result = await confirm(
      { summary: 's', current: 1, proposed: 2 },
      { assume: 'yes', stdout, stderr, isTTY: false },
    );
    assert.equal(result, true);
    assert.equal(stdout.chunks.length, 0);
    assert.equal(stderr.chunks.length, 0);
  });

  it('opts.assume === "no" short-circuits to false without touching streams', async () => {
    const stdout = makeStdout();
    const stderr = makeStdout();
    const result = await confirm(
      { summary: 's', current: 1, proposed: 2 },
      { assume: 'no', stdout, stderr, isTTY: false },
    );
    assert.equal(result, false);
    assert.equal(stderr.chunks.length, 0);
  });

  it('TTY + "y" answer → returns true', async () => {
    const stdout = makeStdout();
    const stderr = makeStdout();
    const stdin = new PassThrough();
    const p = confirm(
      { summary: 'apply?', current: { x: 1 }, proposed: { x: 2 } },
      { stdout, stderr, stdin, isTTY: true },
    );
    // Give readline a tick to register before writing.
    await new Promise((r) => setImmediate(r));
    stdin.write('y\n');
    stdin.end();
    const result = await p;
    assert.equal(result, true);
    const stdoutStr = stdout.chunks.join('');
    assert.match(stdoutStr, /HITL confirm: apply\?/);
    assert.match(stdoutStr, /current/);
    assert.match(stdoutStr, /proposed/);
  });

  it('TTY + empty answer (just Enter) → returns false (N is the default)', async () => {
    const stdout = makeStdout();
    const stderr = makeStdout();
    const stdin = new PassThrough();
    const p = confirm(
      { summary: 's', current: 1, proposed: 2 },
      { stdout, stderr, stdin, isTTY: true },
    );
    await new Promise((r) => setImmediate(r));
    stdin.write('\n');
    stdin.end();
    const result = await p;
    assert.equal(result, false);
  });

  it('TTY + explicit "n" → returns false', async () => {
    const stdout = makeStdout();
    const stderr = makeStdout();
    const stdin = new PassThrough();
    const p = confirm(
      { summary: 's', current: 1, proposed: 2 },
      { stdout, stderr, stdin, isTTY: true },
    );
    await new Promise((r) => setImmediate(r));
    stdin.write('n\n');
    stdin.end();
    const result = await p;
    assert.equal(result, false);
  });
});
