/**
 * The streaming half of the child-process surface; `child-exec.js` owns the
 * `node:child_process` import and injects `spawn`.
 */

import { StringDecoder } from 'node:string_decoder';

import {
  groupSpawnOptions,
  superviseGroup,
  TIMEOUT_EXIT_CODE,
} from './process-group.js';

/** `execFile`'s default `maxBuffer`: callers still see what they saw. */
const STREAM_TAIL_BYTES = 1024 * 1024;

/** Keeps the last `limit` bytes, compacting lazily. */
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

/** Retain the tail and hand decoded text on; a throwing sink is ignored. */
function chunkForwarder(tail, name, onChunk) {
  const decoder = new StringDecoder('utf8');
  return (buf) => {
    tail.push(buf);
    const text = decoder.write(buf);
    if (!onChunk || text.length === 0) return;
    try {
      onChunk(text, name);
    } catch {}
  };
}

/**
 * Shell-free spawn streaming each chunk to `onChunk(text, stream)` in arrival
 * order; only a bounded tail is retained. The process group is killed on
 * `timeoutMs` (status 124, `timedOut`) or `signal` abort. Never rejects.
 *
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
      if (!child.pid) settle(1);
    });
    child.on('close', settle);
    child.stdin.on('error', () => {});
    child.stdin.end(input ?? '');
  });
}
