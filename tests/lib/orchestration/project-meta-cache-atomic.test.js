/**
 * Story #5684 — the project-meta cache is shared by every cold CLI process on
 * the host, so a write must never be observable half-done. The interleaving
 * is made deterministic by stalling `writeFileSync` mid-write: it lands the
 * first half of its bytes, a reader runs, then the rest lands. A write that
 * targets the cache file itself exposes the half-file to that reader; a
 * tmp + rename write exposes only the complete old file.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

import {
  invalidateProjectMetaCache,
  readProjectMetaCache,
  writeProjectMetaCache,
} from '../../../.agents/scripts/lib/orchestration/project-meta-cache.js';
import { makeTempDir } from '../../../.agents/scripts/lib/test-temp.js';

const META = {
  projectId: 'PVT_1',
  fieldId: 'PVTSSF_1',
  options: new Map([['Ready', 'opt-1']]),
};

describe('project-meta cache — atomic writes (Story #5684)', () => {
  let dir;
  let config;
  let cacheFile;

  beforeEach(() => {
    dir = makeTempDir('project-meta-atomic-');
    config = { project: { paths: { tempRoot: dir } } };
    cacheFile = path.join(dir, 'cache', 'project-meta.json');
  });

  afterEach(() => {
    mock.restoreAll();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /**
   * Stall every `writeFileSync` halfway and run `reader` in the gap.
   *
   * @param {() => void} reader
   */
  function stallWritesMidway(reader) {
    const realWrite = fs.writeFileSync.bind(fs);
    mock.method(fs, 'writeFileSync', (file, data, options) => {
      const text = String(data);
      realWrite(file, text.slice(0, Math.floor(text.length / 2)), options);
      reader();
      realWrite(file, text, options);
    });
  }

  /** What a concurrent process sees at the cache path right now. */
  function observe(seen) {
    return () => {
      let raw = null;
      try {
        raw = fs.readFileSync(cacheFile, 'utf8');
      } catch {
        seen.push({ absent: true });
        return;
      }
      try {
        seen.push({ parsed: JSON.parse(raw) });
      } catch {
        seen.push({ partial: raw });
      }
    };
  }

  it('AC-6: a reader mid-write sees the previous complete file, never a partial one', () => {
    assert.equal(
      writeProjectMetaCache({
        owner: 'acme',
        projectNumber: 1,
        meta: META,
        config,
      }),
      true,
    );

    const seen = [];
    stallWritesMidway(observe(seen));
    assert.equal(
      writeProjectMetaCache({
        owner: 'acme',
        projectNumber: 2,
        meta: META,
        config,
      }),
      true,
    );
    mock.restoreAll();

    assert.equal(seen.length, 1, 'the reader ran inside the write');
    assert.deepEqual(
      seen.filter((s) => 'partial' in s),
      [],
      'no reader observed a partially written file',
    );
    assert.deepEqual(Object.keys(seen[0].parsed), ['acme/1']);
    assert.ok(
      readProjectMetaCache({ owner: 'acme', projectNumber: 2, config }),
    );
    assert.deepEqual(
      fs.readdirSync(path.dirname(cacheFile)),
      ['project-meta.json'],
      'no temp file is left behind',
    );
  });

  it('AC-6: invalidation is atomic too', () => {
    writeProjectMetaCache({
      owner: 'acme',
      projectNumber: 1,
      meta: META,
      config,
    });
    writeProjectMetaCache({
      owner: 'acme',
      projectNumber: 2,
      meta: META,
      config,
    });

    const seen = [];
    stallWritesMidway(observe(seen));
    assert.equal(
      invalidateProjectMetaCache({ owner: 'acme', projectNumber: 1, config }),
      true,
    );
    mock.restoreAll();

    assert.equal(seen.length, 1);
    assert.deepEqual(Object.keys(seen[0].parsed), ['acme/1', 'acme/2']);
    assert.equal(
      readProjectMetaCache({ owner: 'acme', projectNumber: 1, config }),
      null,
    );
  });

  it('a failed rename stays best-effort and reaps its temp file', () => {
    mock.method(fs, 'renameSync', () => {
      throw Object.assign(new Error('EXDEV'), { code: 'EXDEV' });
    });
    assert.equal(
      writeProjectMetaCache({
        owner: 'acme',
        projectNumber: 1,
        meta: META,
        config,
      }),
      false,
    );
    mock.restoreAll();
    assert.deepEqual(fs.readdirSync(path.dirname(cacheFile)), []);
  });
});
