// tests/lib/fs-walk.test.js
/**
 * Contract for the shared lint walker (Story #5024).
 *
 * `check-lifecycle-lint.js` and `lint-label-vocabulary.js` each carried a
 * private copy of this generator differing only in the extension matched. The
 * extraction is only safe if the shared version keeps both behaviours the
 * copies relied on:
 *
 *   1. recursion into nested directories;
 *   2. filtering on the caller's extension, not a hardcoded one;
 *   3. a missing directory yielding nothing rather than throwing — load-bearing
 *      because a lint surface can legitimately be deleted (this Story deleted
 *      `lifecycle/listeners/`), and a scan of an absent path is vacuously
 *      clean;
 *   4. any OTHER readdir failure still propagating, so a genuinely broken scan
 *      can never read as clean.
 */

import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { makeTempDir } from '../../.agents/scripts/lib/test-temp.js';
import { walkFilesByExtension } from '../../scripts/lib/fs-walk.js';

describe('lib/fs-walk — walkFilesByExtension', () => {
  let dir;
  beforeEach(() => {
    dir = makeTempDir('mandrel-fs-walk-');
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('recurses and yields only files matching the requested extension', () => {
    const nested = path.join(dir, 'a', 'b');
    mkdirSync(nested, { recursive: true });
    writeFileSync(path.join(dir, 'top.js'), '', 'utf8');
    writeFileSync(path.join(nested, 'deep.js'), '', 'utf8');
    writeFileSync(path.join(nested, 'other.md'), '', 'utf8');

    const js = [...walkFilesByExtension(dir, '.js')].sort();
    assert.deepEqual(
      js,
      [path.join(nested, 'deep.js'), path.join(dir, 'top.js')].sort(),
    );

    const md = [...walkFilesByExtension(dir, '.md')];
    assert.deepEqual(md, [path.join(nested, 'other.md')]);
  });

  it('yields nothing for a directory that does not exist', () => {
    assert.deepEqual(
      [...walkFilesByExtension(path.join(dir, 'nope'), '.js')],
      [],
    );
  });

  it('propagates a readdir failure that is not ENOENT', () => {
    const boom = Object.assign(new Error('EACCES: permission denied'), {
      code: 'EACCES',
    });
    assert.throws(
      () => [
        ...walkFilesByExtension(dir, '.js', {
          readDir: () => {
            throw boom;
          },
        }),
      ],
      /EACCES/,
    );
  });
});
