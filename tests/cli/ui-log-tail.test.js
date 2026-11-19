// tests/cli/ui-log-tail.test.js — the Story detail's log tail: read only
// inside the dispatch directory, bounded, one readable line per event.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { makeTempDir } from '../../.agents/scripts/lib/test-temp.js';
import { readLogTail } from '../../lib/cli/ui/log-tail.js';

let root;
let dir;
beforeEach(() => {
  root = makeTempDir('mandrel-log-tail-');
  dir = path.join(root, 'dispatch');
  fs.mkdirSync(dir, { recursive: true });
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const event = (value) => JSON.stringify(value);
const assistant = (...content) =>
  event({ type: 'assistant', message: { content } });

function writeLog(lines, name = 'story-7.log') {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
  return file;
}

describe('readLogTail (AC-6)', () => {
  it('summarizes assistant text, tool_use and result events to one line each', () => {
    const long = 'x'.repeat(300);
    const file = writeLog([
      event({ type: 'system', subtype: 'init' }),
      assistant({ type: 'text', text: '  Reading\n the Story  ' }),
      assistant(
        { type: 'tool_use', name: 'Bash', input: { command: `ls ${long}` } },
        { type: 'tool_use', name: 'Read', input: { file_path: '/a/b.js' } },
        { type: 'tool_use', name: 'Glob', input: { pattern: '*' } },
      ),
      event({ type: 'user', message: { content: [] } }),
      assistant({ type: 'text', text: long }),
      event({ type: 'result', subtype: 'success' }),
      'plain text output',
      long,
      '',
    ]);
    const tail = readLogTail(file, { dir });
    assert.deepEqual(tail, [
      'Reading the Story',
      `tool: Bash ${`ls ${long}`.slice(0, 120)}`,
      'tool: Read /a/b.js',
      'tool: Glob',
      'x'.repeat(200),
      'result: success',
      'plain text output',
      'x'.repeat(200),
    ]);
  });

  it('keeps the last 50 lines', () => {
    const lines = Array.from({ length: 80 }, (_, i) => `line ${i}`);
    const tail = readLogTail(writeLog(lines), { dir });
    assert.equal(tail.length, 50);
    assert.equal(tail[0], 'line 30');
    assert.equal(tail.at(-1), 'line 79');
  });

  it('reads only the last 64 KiB and drops the cut-off first line', () => {
    const big = `${'a'.repeat(70 * 1024)}`;
    const file = writeLog([big, 'kept']);
    const opened = [];
    const fsImpl = {
      ...fs,
      readSync: (fd, buffer, offset, length, position) => {
        opened.push({ length, position });
        return fs.readSync(fd, buffer, offset, length, position);
      },
    };
    assert.deepEqual(readLogTail(file, { dir, fsImpl }), ['kept']);
    assert.equal(opened[0].length, 64 * 1024);
    assert.equal(opened[0].position, fs.statSync(file).size - 64 * 1024);
  });

  it('reads nothing outside the dispatch directory', () => {
    const outside = path.join(root, 'secret.log');
    fs.writeFileSync(outside, 'secret\n');
    for (const logPath of [
      outside,
      path.join(dir, '..', 'secret.log'),
      dir,
      null,
      undefined,
      42,
    ]) {
      assert.deepEqual(readLogTail(logPath, { dir }), []);
    }
  });

  it('is empty for a missing log', () => {
    assert.deepEqual(readLogTail(path.join(dir, 'story-404.log'), { dir }), []);
  });
});
