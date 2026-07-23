/**
 * Unit tests for `.agents/scripts/check-test-temp-hygiene.js` (Story #4696).
 *
 * Every test builds an isolated fake repo root under `os.tmpdir()` and points
 * the guard at it via `--root` / the `repoRoot` option, so the suite never
 * touches the real `temp/` tree it is meant to protect.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  buildManifest,
  cleanFixtureDirs,
  defaultBaselinePath,
  diffAgainstSnapshot,
  findFixtureDirs,
  isStreamFile,
  KNOWN_FIXTURE_STORY_IDS,
  listStreamFiles,
  parseArgv,
  readSnapshot,
  runHygiene,
  tempDirFor,
  writeSnapshot,
} from '../.agents/scripts/check-test-temp-hygiene.js';

let repoRoot;

beforeEach(() => {
  repoRoot = mkdtempSync(path.join(tmpdir(), 'temp-hygiene-'));
});
afterEach(() => {
  // The default baseline lives OUTSIDE repoRoot (Story #4711) — sweep it too.
  rmSync(defaultBaselinePath(repoRoot), { force: true });
  rmSync(repoRoot, { recursive: true, force: true });
});

/** Write a stream file at temp/<rel> with `content`, creating parents. */
function writeStream(rel, content) {
  const abs = path.join(tempDirFor(repoRoot), rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content, 'utf8');
  return abs;
}

describe('check-test-temp-hygiene — isStreamFile', () => {
  it('matches ndjson under run-<id>/ and standalone/stories/', () => {
    assert.equal(isStreamFile('run-7/lifecycle.ndjson'), true);
    assert.equal(isStreamFile('run-7/stories/story-8/signals.ndjson'), true);
    assert.equal(
      isStreamFile('standalone/stories/story-9/signals.ndjson'),
      true,
    );
    assert.equal(
      isStreamFile('standalone/stories/story-9/traces.ndjson'),
      true,
    );
  });

  it('rejects non-ndjson and unrelated locations', () => {
    assert.equal(isStreamFile('run-7/manifest.md'), false);
    assert.equal(isStreamFile('epic-runner-logs/x.ndjson'), false);
    assert.equal(isStreamFile('loose.ndjson'), false);
    assert.equal(isStreamFile('.test-temp-hygiene-snapshot.json'), false);
  });
});

describe('check-test-temp-hygiene — listStreamFiles / buildManifest', () => {
  it('lists only stream files, sorted, and fingerprints them', () => {
    writeStream('run-1/lifecycle.ndjson', 'a\n');
    writeStream('run-1/stories/story-2/signals.ndjson', 'bb\n');
    writeStream('standalone/stories/story-3/traces.ndjson', 'ccc\n');
    writeStream('run-1/manifest.md', 'ignored');
    writeStream('loose.ndjson', 'ignored-too');

    const files = listStreamFiles(tempDirFor(repoRoot));
    assert.deepEqual(files, [
      'run-1/lifecycle.ndjson',
      'run-1/stories/story-2/signals.ndjson',
      'standalone/stories/story-3/traces.ndjson',
    ]);

    const manifest = buildManifest(tempDirFor(repoRoot));
    assert.equal(manifest['run-1/lifecycle.ndjson'].size, 2);
    assert.equal(typeof manifest['run-1/lifecycle.ndjson'].sha256, 'string');
  });

  it('returns an empty list when temp/ does not exist', () => {
    assert.deepEqual(listStreamFiles(tempDirFor(repoRoot)), []);
  });
});

describe('check-test-temp-hygiene — snapshot + diff', () => {
  it('snapshot then unchanged tree diffs clean', () => {
    writeStream('run-1/lifecycle.ndjson', 'a\n');
    writeSnapshot(repoRoot);
    const snapshot = readSnapshot(repoRoot);
    const { added, changed } = diffAgainstSnapshot(
      tempDirFor(repoRoot),
      snapshot,
    );
    assert.deepEqual(added, []);
    assert.deepEqual(changed, []);
  });

  it('detects an added stream file', () => {
    writeStream('run-1/lifecycle.ndjson', 'a\n');
    writeSnapshot(repoRoot);
    writeStream('run-2/stories/story-5/signals.ndjson', 'new\n');
    const { added, changed } = diffAgainstSnapshot(
      tempDirFor(repoRoot),
      readSnapshot(repoRoot),
    );
    assert.deepEqual(added, ['run-2/stories/story-5/signals.ndjson']);
    assert.deepEqual(changed, []);
  });

  it('detects a grown / rewritten stream file', () => {
    writeStream('run-1/lifecycle.ndjson', 'a\n');
    writeSnapshot(repoRoot);
    writeStream('run-1/lifecycle.ndjson', 'a\nb\n');
    const { added, changed } = diffAgainstSnapshot(
      tempDirFor(repoRoot),
      readSnapshot(repoRoot),
    );
    assert.deepEqual(added, []);
    assert.deepEqual(changed, ['run-1/lifecycle.ndjson']);
  });

  it('readSnapshot returns null when no snapshot exists', () => {
    assert.equal(readSnapshot(repoRoot), null);
  });
});

describe('check-test-temp-hygiene — external baseline (Story #4711, AC-2)', () => {
  it('defaultBaselinePath lives outside the repo root and its temp/ tree', () => {
    const baseline = defaultBaselinePath(repoRoot);
    assert.ok(path.isAbsolute(baseline));
    assert.ok(
      !baseline.startsWith(repoRoot + path.sep),
      `baseline ${baseline} must not live under the repo root`,
    );
    assert.ok(
      !baseline.startsWith(tempDirFor(repoRoot) + path.sep),
      `baseline ${baseline} must not live under the protected temp/ tree`,
    );
  });

  it('defaultBaselinePath is keyed by repo root (no cross-checkout collision)', () => {
    const other = mkdtempSync(path.join(tmpdir(), 'temp-hygiene-other-'));
    try {
      assert.notEqual(
        defaultBaselinePath(repoRoot),
        defaultBaselinePath(other),
      );
      assert.equal(
        defaultBaselinePath(repoRoot),
        defaultBaselinePath(repoRoot),
      );
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it('writeSnapshot persists to the external default and leaves temp/ clean', async () => {
    writeStream('run-1/lifecycle.ndjson', 'a\n');
    const { snapshotPath } = writeSnapshot(repoRoot);
    assert.equal(snapshotPath, defaultBaselinePath(repoRoot));
    await fs.stat(snapshotPath);
    // Nothing snapshot-shaped was written under the protected tree.
    const tempEntries = await fs.readdir(tempDirFor(repoRoot));
    assert.deepEqual(tempEntries.sort(), ['run-1']);
  });

  it('writeSnapshot / readSnapshot honour an explicit external baseline path', () => {
    writeStream('run-1/lifecycle.ndjson', 'a\n');
    const custom = path.join(repoRoot, 'ci-scratch', 'hygiene.json');
    const { snapshotPath } = writeSnapshot(repoRoot, custom);
    assert.equal(snapshotPath, custom);
    const snapshot = readSnapshot(repoRoot, custom);
    assert.ok(snapshot !== null);
    assert.ok(snapshot['run-1/lifecycle.ndjson']);
  });

  it('refuses a baseline path inside the protected temp/ tree', () => {
    const inTemp = path.join(tempDirFor(repoRoot), 'snapshot.json');
    assert.throws(
      () => writeSnapshot(repoRoot, inTemp),
      /must live outside the protected temp\/ tree/,
    );
    assert.throws(
      () => readSnapshot(repoRoot, inTemp),
      /must live outside the protected temp\/ tree/,
    );
  });
});

describe('check-test-temp-hygiene — findFixtureDirs / cleanFixtureDirs (AC-4)', () => {
  it('finds run-<id> and standalone story dirs matching fixture ids', () => {
    writeStream('run-4428/lifecycle.ndjson', 'x\n');
    writeStream('standalone/stories/story-10/signals.ndjson', 'y\n');
    writeStream('run-999/lifecycle.ndjson', 'real\n'); // non-fixture id

    const found = findFixtureDirs(
      tempDirFor(repoRoot),
      new Set(KNOWN_FIXTURE_STORY_IDS),
    );
    const rels = found.map((f) => f.rel);
    assert.ok(rels.includes('run-4428'));
    assert.ok(rels.includes('standalone/stories/story-10'));
    assert.ok(!rels.includes('run-999'), 'non-fixture ids are untouched');
  });

  it('report-only clean (default) lists candidates and deletes nothing', async () => {
    writeStream('run-4428/lifecycle.ndjson', 'x\n');
    writeStream('standalone/stories/story-10/signals.ndjson', 'y\n');

    const { candidates, removed } = cleanFixtureDirs({ repoRoot });
    assert.equal(candidates.length, 2);
    assert.deepEqual(removed, []);
    // Nothing deleted.
    await fs.stat(path.join(tempDirFor(repoRoot), 'run-4428'));
    await fs.stat(
      path.join(tempDirFor(repoRoot), 'standalone', 'stories', 'story-10'),
    );
  });

  it('--yes clean deletes the fixture dirs', async () => {
    writeStream('run-4428/lifecycle.ndjson', 'x\n');
    writeStream('run-999/lifecycle.ndjson', 'real\n');

    const { removed } = cleanFixtureDirs({ repoRoot, apply: true });
    assert.deepEqual(removed, ['run-4428']);
    await assert.rejects(() =>
      fs.stat(path.join(tempDirFor(repoRoot), 'run-4428')),
    );
    // Non-fixture dir survives.
    await fs.stat(path.join(tempDirFor(repoRoot), 'run-999'));
  });

  it('honours a custom fixture-id list', () => {
    writeStream('run-777/lifecycle.ndjson', 'x\n');
    const { candidates } = cleanFixtureDirs({ repoRoot, ids: [777] });
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].id, 777);
  });
});

describe('check-test-temp-hygiene — parseArgv', () => {
  it('defaults to assert mode', () => {
    const opts = parseArgv([]);
    assert.equal(opts.mode, 'assert');
    assert.equal(opts.apply, false);
    assert.equal(opts.ids, null);
  });

  it('parses each mode, --yes, --ids, --root, and --baseline', () => {
    assert.equal(parseArgv(['--snapshot']).mode, 'snapshot');
    assert.equal(parseArgv(['--clean']).mode, 'clean');
    assert.equal(parseArgv(['--clean', '--yes']).apply, true);
    assert.deepEqual(parseArgv(['--ids', '1, 2,3']).ids, [1, 2, 3]);
    assert.equal(
      parseArgv(['--root', '/tmp/x']).repoRoot,
      path.resolve('/tmp/x'),
    );
    assert.equal(parseArgv([]).baseline, null);
    assert.equal(
      parseArgv(['--baseline', '/tmp/x/base.json']).baseline,
      path.resolve('/tmp/x/base.json'),
    );
  });
});

describe('check-test-temp-hygiene — runHygiene', () => {
  const collect = () => {
    const lines = [];
    return { lines, log: (l) => lines.push(l) };
  };

  it('snapshot mode records the baseline and returns 0', () => {
    writeStream('run-1/lifecycle.ndjson', 'a\n');
    const { lines, log } = collect();
    const code = runHygiene(
      { mode: 'snapshot', apply: false, ids: null, repoRoot },
      log,
    );
    assert.equal(code, 0);
    assert.ok(readSnapshot(repoRoot) !== null);
    assert.ok(lines.join('\n').includes('snapshot recorded'));
  });

  it('assert with no prior snapshot fails closed naming the missing baseline (AC-1)', () => {
    writeStream('run-1/lifecycle.ndjson', 'a\n');
    const { lines, log } = collect();
    const code = runHygiene(
      { mode: 'assert', apply: false, ids: null, repoRoot },
      log,
    );
    assert.equal(code, 1);
    const out = lines.join('\n');
    assert.ok(out.includes('snapshot missing'));
    assert.ok(out.includes(defaultBaselinePath(repoRoot)));
    assert.ok(!out.includes('baseline recorded'), 'must never re-baseline');
  });

  it('assert fails closed after the baseline is deleted (wiped-temp scenario, AC-1)', () => {
    writeStream('run-1/lifecycle.ndjson', 'a\n');
    const { snapshotPath } = writeSnapshot(repoRoot);
    rmSync(snapshotPath, { force: true });
    const { lines, log } = collect();
    const code = runHygiene(
      { mode: 'assert', apply: false, ids: null, repoRoot },
      log,
    );
    assert.equal(code, 1);
    const out = lines.join('\n');
    assert.ok(out.includes('snapshot missing'));
    assert.ok(out.includes(snapshotPath));
    // Still no re-baseline on the failing path.
    assert.equal(readSnapshot(repoRoot), null);
  });

  it('assert honours an explicit --baseline path end-to-end', () => {
    writeStream('run-1/lifecycle.ndjson', 'a\n');
    const custom = path.join(repoRoot, 'ci-scratch', 'hygiene.json');
    writeSnapshot(repoRoot, custom);
    writeStream('run-2/stories/story-9/signals.ndjson', 'polluted\n');
    const { lines, log } = collect();
    const code = runHygiene(
      { mode: 'assert', apply: false, ids: null, repoRoot, baseline: custom },
      log,
    );
    assert.equal(code, 1);
    assert.ok(lines.join('\n').includes('polluted the real temp/ tree'));
  });

  it('assert returns 0 when the tree is unchanged since snapshot', () => {
    writeStream('run-1/lifecycle.ndjson', 'a\n');
    writeSnapshot(repoRoot);
    const code = runHygiene(
      { mode: 'assert', apply: false, ids: null, repoRoot },
      () => {},
    );
    assert.equal(code, 0);
  });

  it('assert returns 1 when a new stream file appeared', () => {
    writeStream('run-1/lifecycle.ndjson', 'a\n');
    writeSnapshot(repoRoot);
    writeStream('run-2/stories/story-9/signals.ndjson', 'polluted\n');
    const { lines, log } = collect();
    const code = runHygiene(
      { mode: 'assert', apply: false, ids: null, repoRoot },
      log,
    );
    assert.equal(code, 1);
    assert.ok(lines.join('\n').includes('polluted the real temp/ tree'));
  });

  it('clean mode reports candidates without deleting and returns 0', async () => {
    writeStream('run-4428/lifecycle.ndjson', 'x\n');
    const { lines, log } = collect();
    const code = runHygiene(
      { mode: 'clean', apply: false, ids: null, repoRoot },
      log,
    );
    assert.equal(code, 0);
    assert.ok(lines.join('\n').includes('run-4428'));
    await fs.stat(path.join(tempDirFor(repoRoot), 'run-4428'));
  });

  it('clean mode with no candidates returns 0', () => {
    const { lines, log } = collect();
    const code = runHygiene(
      { mode: 'clean', apply: false, ids: null, repoRoot },
      log,
    );
    assert.equal(code, 0);
    assert.ok(lines.join('\n').includes('no fixture-id stream directories'));
  });
});
