import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import { makeTempDir } from '../../../.agents/scripts/lib/test-temp.js';
import { walkFiles } from '../../../.agents/scripts/lib/util/paths.js';

/** Empty files at each repo-relative path, under a fresh temp root. */
function tree(files) {
  const root = makeTempDir('walk-');
  for (const rel of files) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, '');
  }
  return root;
}

const rel = (root, list) =>
  list.map((abs) => path.relative(root, abs).split(path.sep).join('/')).sort();

describe('walkFiles', () => {
  it('returns absolute paths of every file, recursively', () => {
    const root = tree(['a.js', 'sub/b.js', 'sub/deep/c.md']);
    const out = walkFiles(root);
    assert.ok(out.every((p) => path.isAbsolute(p)));
    assert.deepEqual(rel(root, out), ['a.js', 'sub/b.js', 'sub/deep/c.md']);
  });

  it('prunes a skipped directory before descending into it', () => {
    const root = tree(['a.js', 'node_modules/x/y.js', 'src/node_modules/z.js']);
    const reads = [];
    const fsImpl = {
      ...fs,
      readdirSync: (dir, opts) => {
        reads.push(path.relative(root, dir));
        return fs.readdirSync(dir, opts);
      },
    };
    const out = walkFiles(root, { skipDirs: ['node_modules'], fsImpl });
    assert.deepEqual(rel(root, out), ['a.js']);
    assert.ok(!reads.some((d) => d.includes('node_modules')), reads.join(','));
  });

  it('accepts a skipDirs predicate', () => {
    const root = tree(['a.js', '.hidden/b.js', 'src/c.js']);
    const out = walkFiles(root, { skipDirs: (name) => name.startsWith('.') });
    assert.deepEqual(rel(root, out), ['a.js', 'src/c.js']);
  });

  it('keeps only the files `filter(absPath, dirent)` accepts', () => {
    const root = tree(['a.js', 'b.md', 'sub/c.js']);
    const seen = [];
    const out = walkFiles(root, {
      filter: (abs, dirent) => {
        seen.push([path.basename(abs), dirent.name]);
        return dirent.name.endsWith('.js');
      },
    });
    assert.deepEqual(rel(root, out), ['a.js', 'sub/c.js']);
    assert.ok(seen.every(([base, name]) => base === name));
  });

  it('returns [] for a missing root', () => {
    assert.deepEqual(walkFiles(path.join(makeTempDir('walk-'), 'absent')), []);
  });

  it('throws any readdir error other than a missing root', () => {
    const root = tree(['sub/a.js']);
    const fsImpl = {
      ...fs,
      readdirSync: (dir, opts) => {
        if (dir !== root) {
          throw Object.assign(new Error('EACCES denied'), { code: 'EACCES' });
        }
        return fs.readdirSync(dir, opts);
      },
    };
    assert.throws(() => walkFiles(root, { fsImpl }), /EACCES denied/);
  });

  it('with onError, reports an unreadable subdirectory and keeps its siblings', () => {
    const root = tree(['a.js', 'locked/b.js', 'open/c.js']);
    const locked = path.join(root, 'locked');
    const fsImpl = {
      ...fs,
      readdirSync: (dir, opts) => {
        if (dir === locked) {
          throw Object.assign(new Error('EACCES denied'), { code: 'EACCES' });
        }
        return fs.readdirSync(dir, opts);
      },
    };
    const errors = [];
    const out = walkFiles(root, {
      fsImpl,
      onError: (err, dir) => errors.push([err.code, dir]),
    });
    assert.deepEqual(rel(root, out), ['a.js', 'open/c.js']);
    assert.deepEqual(errors, [['EACCES', locked]]);
  });

  it('throws when the root is a file, not a directory', () => {
    const root = tree(['a.js']);
    assert.throws(() => walkFiles(path.join(root, 'a.js')), {
      code: 'ENOTDIR',
    });
  });
});
