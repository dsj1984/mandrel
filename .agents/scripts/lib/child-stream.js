/**
 * child-stream.js — the streaming half of the child-process surface
 * (Story #5694). `child-exec.js` owns the `node:child_process` import and
 * hands `spawn` in, so this module stays out of the importer allowlist.
 *
 * @module lib/child-stream
 */

import { StringDecoder } from 'node:string_decoder';

import {
  groupSpawnOptions,
  superviseGroup,
  TIMEOUT_EXIT_CODE,
} from './process-group.js';

const MIB = 1024 * 1024;

/**
 * The streamed runner's retained tail per stream: `execFile`'s default
 * `maxBuffer`, so a caller matching output sees at least what it saw before
 * the runner streamed — and a larger output no longer fails the child.
 *
 * @type {number}
 */
const STREAM_TAIL_BYTES = MIB;

/**
 * A byte-bounded tail: keeps the last `limit` bytes, compacting lazily.
 *
 * @param {number} limit
 * @returns {{ push: (buf: Buffer) => void, text: () => string }}
 */
function createTail(limit) {
  let chunks = [];
  let size = 0;
  const compact = () => {
    if (size <= limit) return;
    const all = Buffer.concat(chunks);
    chunks = [all.subarray(all.length - limit)];
    size = limit;
  };
  return {
    push(buf) {
      chunks.push(buf);
      size += buf.length;
      if (size > limit * 2) compact();
    },
    text() {
      compact();
      return Buffer.concat(chunks).toString('utf8');
    },
  };
}

/**
 * One stream's `data` handler: retain the tail, hand the decoded text on.
 * A throwing `onChunk` never kills the run.
 */
function chunkForwarder(tail, name, onChunk) {
  const decoder = new StringDecoder('utf8');
  return (buf) => {
    tail.push(buf);
    const text = decoder.write(buf);
    if (!onChunk || text.length === 0) return;
    try {
      onChunk(text, name);
    } catch {
      // The sink's failure is the sink's to report.
    }
  };
}

/**
 * Spawn without a shell and stream: each stdout/stderr chunk reaches
 * `onChunk(text, 'stdout'|'stderr')` in arrival order, while only a bounded
 * tail is retained. The child runs as a process group, killed whole on
 * `timeoutMs` (status → `TIMEOUT_EXIT_CODE`, `timedOut: true`) or when
 * `signal` aborts. Never rejects: a spawn error resolves status 1.
 *
 * @param {string}   file
 * @param {string[]} args
 * @param {object}   [opts] spawn options plus the fields below.
 * @param {(text: string, stream: 'stdout'|'stderr') => void} [opts.onChunk]
 * @param {number}   [opts.timeoutMs]
 * @param {AbortSignal} [opts.signal]
 * @param {string}   [opts.input] written to stdin, which is then closed.
 * @param {number}   [opts.tailBytes]
 * @param {Function} opts.spawnImpl `child_process.spawn`, injected.
 * @returns {Promise<{ status: number, stdout: string, stderr: string, timedOut: boolean, pid: number|null }>}
 */
export function streamChild(file, args, opts = {}) {
  const {
    onChunk,
    timeoutMs,
    signal,
    input,
    tailBytes = STREAM_TAIL_BYTES,
    spawnImpl,
    ...rest
  } = opts;
  return new Promise((resolve) => {
    const stdout = createTail(tailBytes);
    const stderr = createTail(tailBytes);
    let child;
    try {
      child = spawnImpl(file, args, {
        ...rest,
        ...groupSpawnOptions(),
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      resolve({
        status: 1,
        stdout: '',
        stderr: err.message,
        timedOut: false,
        pid: null,
      });
      return;
    }
    const supervisor = superviseGroup(child, {
      timeoutMs,
      abortSignal: signal,
      signalOnParentSignal: 'SIGTERM',
    });
    let spawnError = null;
    let settled = false;
    const settle = (code) => {
      if (settled) return;
      settled = true;
      supervisor.release();
      const { timedOut } = supervisor;
      const exited = Number.isInteger(code) ? code : 1;
      resolve({
        status: timedOut ? TIMEOUT_EXIT_CODE : exited,
        stdout: stdout.text().trim(),
        stderr: (stderr.text() || spawnError?.message || '').trim(),
        timedOut,
        pid: child.pid ?? null,
      });
    };
    child.stdout.on('data', chunkForwarder(stdout, 'stdout', onChunk));
    child.stderr.on('data', chunkForwarder(stderr, 'stderr', onChunk));
    child.on('error', (err) => {
      spawnError = err;
      // A child that never started emits no `close` on every platform.
      if (!child.pid) settle(1);
    });
    child.on('close', settle);
    child.stdin.on('error', () => {});
    child.stdin.end(input ?? '');
  });
}
