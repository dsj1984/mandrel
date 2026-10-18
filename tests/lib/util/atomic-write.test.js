import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { makeTempDir } from '../../../.agents/scripts/lib/test-temp.js';
import { writeFileAtomic } from '../../../.agents/scripts/lib/util/atomic-write.js';

const MODULE_URL = pathToFileURL(
  path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../../.agents/scripts/lib/util/atomic-write.js',
  ),
).href;

/** A real fs whose write and rename calls are recorded. */
function recordingFs(overrides = {}) {
  const ops = [];
  return {
    ops,
    fsImpl: {
      ...fs,
      writeFileSync: (p, ...rest) => {
        ops.push(['write', p]);
        return fs.writeFileSync(p, ...rest);
      },
      renameSync: (from, to) => {
        ops.push(['rename', from, to]);
        return fs.renameSync(from, to);
      },
      ...overrides,
    },
  };
}

describe('writeFileAtomic', () => {
  it('creates the parent directory and lands the contents', () => {
    const target = path.join(makeTempDir('atomic-'), 'a', 'b', 'out.json');
    writeFileAtomic(target, '{"ok":true}\n');
    assert.equal(fs.readFileSync(target, 'utf8'), '{"ok":true}\n');
    assert.deepEqual(fs.readdirSync(path.dirname(target)), ['out.json']);
  });

  it('writes a pid-scoped tmp sibling, then renames it over the target', () => {
    const target = path.join(makeTempDir('atomic-'), 'out.txt');
    const { ops, fsImpl } = recordingFs();
    writeFileAtomic(target, 'x', { fsImpl });
    const tmp = `${target}.${process.pid}.tmp`;
    assert.deepEqual(ops, [
      ['write', tmp],
      ['rename', tmp, target],
    ]);
  });

  it('a failed rename reaps the tmp, leaves the target alone, and rethrows', () => {
    const dir = makeTempDir('atomic-');
    const target = path.join(dir, 'out.txt');
    fs.writeFileSync(target, 'before');
    const { fsImpl } = recordingFs({
      renameSync: () => {
        throw new Error('EXDEV boom');
      },
    });
    assert.throws(
      () => writeFileAtomic(target, 'after', { fsImpl }),
      /EXDEV boom/,
    );
    assert.deepEqual(fs.readdirSync(dir), ['out.txt']);
    assert.equal(fs.readFileSync(target, 'utf8'), 'before');
  });

  it('reaps through unlinkSync when the injected fs has no rmSync', () => {
    const removed = [];
    const fsImpl = {
      mkdirSync: () => {},
      writeFileSync: () => {},
      renameSync: () => {
        throw new Error('rename failed');
      },
      unlinkSync: (p) => removed.push(p),
    };
    assert.throws(
      () => writeFileAtomic('/x/out.txt', 'x', { fsImpl }),
      /rename failed/,
    );
    assert.deepEqual(removed, [`/x/out.txt.${process.pid}.tmp`]);
  });

  it('routes every call through the injected fs and never touches disk', () => {
    const calls = [];
    const record =
      (name) =>
      (...args) =>
        calls.push([name, args[0]]);
    const fsImpl = {
      mkdirSync: record('mkdir'),
      writeFileSync: record('write'),
      renameSync: record('rename'),
    };
    writeFileAtomic('/never/touched/out.txt', 'x', { fsImpl });
    assert.deepEqual(calls, [
      ['mkdir', '/never/touched'],
      ['write', `/never/touched/out.txt.${process.pid}.tmp`],
      ['rename', `/never/touched/out.txt.${process.pid}.tmp`],
    ]);
  });

  it('two writers in different processes never share a tmp name', () => {
    const script = `
      const { writeFileAtomic } = await import(${JSON.stringify(MODULE_URL)});
      let tmp;
      writeFileAtomic('/t/out.txt', 'x', { fsImpl: {
        mkdirSync() {}, writeFileSync(p) { tmp = p; }, renameSync() {},
      } });
      process.stdout.write(tmp);
    `;
    const run = () =>
      execFileSync(process.execPath, ['--input-type=module', '-e', script], {
        encoding: 'utf8',
      });
    const [a, b] = [run(), run()];
    assert.match(a, /^\/t\/out\.txt\.\d+\.tmp$/);
    assert.notEqual(a, b);
  });
});
