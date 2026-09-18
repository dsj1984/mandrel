import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';

import { retireEpicAcTags } from '../../../lib/migrations/steps/2.2.0-retire-epic-ac-tags.js';

/**
 * Story #4780 — `stripEpicAcTags` (CRAP 42) and `collectFeatureFiles`
 * (CRAP 30) were unreached: the migration step had no test at all, so the
 * tag-line rewrite rules it encodes were unverified.
 *
 * Every stub below is a plain object passed through the step's optional final
 * `fsImpl` parameter (`docs/contributing/test-seams.md` rules 1 and 5) — no
 * module mocking, no module-level seam state.
 */

/**
 * Build an in-memory `node:fs` stub over a `{ '<abs path>': '<content>' }`
 * map. Directory structure is derived from the keys, so a fixture is declared
 * by its files alone.
 *
 * @param {Record<string, string>} files
 */
function makeFsStub(files) {
  const writes = {};
  const dirs = new Set();
  for (const file of Object.keys(files)) {
    let dir = path.dirname(file);
    while (dir && dir !== path.dirname(dir)) {
      dirs.add(dir);
      dir = path.dirname(dir);
    }
  }
  return {
    writes,
    readdirSync(dir, _opts) {
      if (!dirs.has(dir)) {
        const err = new Error(`ENOENT: ${dir}`);
        throw err;
      }
      const names = new Map();
      for (const file of Object.keys(files)) {
        if (path.dirname(file) === dir) {
          names.set(path.basename(file), false);
          continue;
        }
        if (!file.startsWith(`${dir}${path.sep}`)) continue;
        const rest = file.slice(dir.length + 1);
        names.set(rest.split(path.sep)[0], true);
      }
      return [...names].map(([name, isDir]) => ({
        name,
        isDirectory: () => isDir,
        isFile: () => !isDir,
      }));
    },
    readFileSync(file) {
      if (!(file in files)) throw new Error(`ENOENT: ${file}`);
      return files[file];
    },
    writeFileSync(file, content) {
      writes[file] = content;
      files[file] = content;
    },
  };
}

const ROOT = path.resolve(path.sep, 'consumer');
const featurePath = (...parts) =>
  path.join(ROOT, 'tests', 'features', ...parts);

describe('retireEpicAcTags.detect', () => {
  it('is false when no feature file carries a retired tag', () => {
    const fsImpl = makeFsStub({
      [featurePath('login.feature')]: '@smoke\nFeature: Login\n',
    });
    assert.equal(retireEpicAcTags.detect({ projectRoot: ROOT }, fsImpl), false);
  });

  it('is true when any feature file carries a retired tag', () => {
    const fsImpl = makeFsStub({
      [featurePath('login.feature')]: '@smoke\nFeature: Login\n',
      [featurePath('nested', 'billing.feature')]:
        '@epic-4604-ac-2\nFeature: Billing\n',
    });
    assert.equal(retireEpicAcTags.detect({ projectRoot: ROOT }, fsImpl), true);
  });

  it('is false when there are no feature roots at all', () => {
    const fsImpl = makeFsStub({});
    assert.equal(retireEpicAcTags.detect({ projectRoot: ROOT }, fsImpl), false);
  });

  it('skips a file whose read throws rather than propagating', () => {
    const fsImpl = makeFsStub({
      [featurePath('ok.feature')]: 'Feature: Fine\n',
    });
    const throwing = {
      ...fsImpl,
      readFileSync: () => {
        throw new Error('EACCES');
      },
    };
    assert.equal(
      retireEpicAcTags.detect({ projectRoot: ROOT }, throwing),
      false,
    );
  });

  it('honours ctx.fs when no explicit fsImpl is passed', () => {
    const fsImpl = makeFsStub({
      [featurePath('a.feature')]: '@epic-1-ac-1\nFeature: A\n',
    });
    assert.equal(
      retireEpicAcTags.detect({ projectRoot: ROOT, fs: fsImpl }),
      true,
    );
  });
});

describe('retireEpicAcTags.apply', () => {
  it('drops a retired tag but keeps the rest of the tag line and its indent', () => {
    const files = {
      [featurePath('a.feature')]:
        '  @smoke @epic-4604-ac-2 @wip\nFeature: A\n  Scenario: s\n',
    };
    const fsImpl = makeFsStub(files);
    retireEpicAcTags.apply({ projectRoot: ROOT }, fsImpl);
    assert.equal(
      fsImpl.writes[featurePath('a.feature')],
      '  @smoke @wip\nFeature: A\n  Scenario: s\n',
    );
  });

  it('removes a tag line whose every tag was retired', () => {
    const files = {
      [featurePath('a.feature')]: '@epic-1-ac-1 @epic-1-ac-2\nFeature: A\n',
    };
    const fsImpl = makeFsStub(files);
    retireEpicAcTags.apply({ projectRoot: ROOT }, fsImpl);
    assert.equal(fsImpl.writes[featurePath('a.feature')], 'Feature: A\n');
  });

  it('never rewrites a file with no retired tags', () => {
    const fsImpl = makeFsStub({
      [featurePath('a.feature')]: '@smoke\nFeature: A\n',
    });
    retireEpicAcTags.apply({ projectRoot: ROOT }, fsImpl);
    assert.deepEqual(fsImpl.writes, {});
  });

  it('leaves a non-tag line mentioning the tag byte-for-byte intact', () => {
    const original = [
      '@smoke',
      'Feature: A',
      '  # historical note: @epic-1-ac-1 used to live here',
      '',
    ].join('\n');
    const fsImpl = makeFsStub({ [featurePath('a.feature')]: original });
    retireEpicAcTags.apply({ projectRoot: ROOT }, fsImpl);
    assert.deepEqual(fsImpl.writes, {});
  });

  it('preserves CRLF line endings', () => {
    const fsImpl = makeFsStub({
      [featurePath('a.feature')]: '@smoke @epic-9-ac-9\r\nFeature: A\r\n',
    });
    retireEpicAcTags.apply({ projectRoot: ROOT }, fsImpl);
    assert.equal(
      fsImpl.writes[featurePath('a.feature')],
      '@smoke\r\nFeature: A\r\n',
    );
  });

  it('walks nested directories and every canonical feature root', () => {
    const nested = path.join(ROOT, 'features', 'deep', 'nest', 'b.feature');
    const files = {
      [featurePath('a.feature')]: '@epic-1-ac-1 @keep\nFeature: A\n',
      [nested]: '@epic-2-ac-2 @also\nFeature: B\n',
      [path.join(ROOT, 'test', 'features', 'c.feature')]:
        '@epic-3-ac-3 @third\nFeature: C\n',
    };
    const fsImpl = makeFsStub(files);
    retireEpicAcTags.apply({ projectRoot: ROOT }, fsImpl);
    assert.deepEqual(
      Object.keys(fsImpl.writes).sort(),
      [
        path.join(ROOT, 'features', 'deep', 'nest', 'b.feature'),
        path.join(ROOT, 'test', 'features', 'c.feature'),
        featurePath('a.feature'),
      ].sort(),
    );
  });

  it('skips an unreadable file rather than aborting the migration', () => {
    const files = { [featurePath('a.feature')]: '@epic-1-ac-1\nFeature: A\n' };
    const base = makeFsStub(files);
    const throwing = {
      ...base,
      readFileSync: () => {
        throw new Error('EACCES');
      },
      writeFileSync: base.writeFileSync,
    };
    assert.doesNotThrow(() =>
      retireEpicAcTags.apply({ projectRoot: ROOT }, throwing),
    );
    assert.deepEqual(base.writes, {});
  });

  it('exposes a stable version/description contract', () => {
    assert.equal(retireEpicAcTags.version, '2.2.0');
    assert.match(retireEpicAcTags.description, /@epic-<id>-ac-N/);
  });
});
