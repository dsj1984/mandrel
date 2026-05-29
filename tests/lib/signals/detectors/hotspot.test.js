/**
 * Unit tests for `lib/signals/detectors/hotspot.js`
 * (Epic #1721 / Story #1769 / Task #1777).
 *
 * Covers every AC bullet:
 *   - Detector walks `temp/epic-<eid>/story-*\/traces.ndjson` for every
 *     Story directory under `temp/epic-<eid>/`, aggregating edit counts
 *     per `targetHash` across Stories.
 *   - Hashes appearing in fewer than 2 Stories are excluded from the
 *     percentile pool AND from emission. The synthetic three-Story
 *     fixture proves both halves: `aa…` is in all three Stories (the
 *     hotspot), `bb…` and `cc…` are each in only one Story (and never
 *     emit even though their counts exceed the cross-Story counts of
 *     the filler hash).
 *   - Emits exactly one signal per offending hash with the `details`
 *     payload `{ targetHash, totalEdits, storiesAffected, p95Threshold,
 *     multiplier }`.
 *   - Returns `[]` when `temp/epic-<eid>/` contains no Story
 *     directories.
 *   - The `nearestRankP95` helper returns expected nearest-rank values
 *     for `[1,2,3,4,5,6,7,8,9,10]` and the single-value `[10]`.
 *
 * Plus the barrel-resolves contract: `import { detectHotspot,
 * nearestRankP95 } from '.agents/scripts/lib/signals/detectors/index.js'`
 * works.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  detectHotspot,
  nearestRankP95,
} from '../../../../.agents/scripts/lib/signals/detectors/hotspot.js';
import {
  detectHotspot as detectHotspotFromBarrel,
  nearestRankP95 as nearestRankP95FromBarrel,
} from '../../../../.agents/scripts/lib/signals/detectors/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, 'fixtures');
const HOTSPOT_FIXTURE_DIR = path.join(FIXTURES_DIR, 'hotspot-epic');

const EPIC_ID = 1721;
const HOTSPOT_HASH =
  'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const STORY1_LOCAL_HASH =
  'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const STORY2_LOCAL_HASH =
  'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';
const FILLER_HASH =
  'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd';

let scratchDir;

/**
 * The detector reads from `tempRoot/epic-<eid>/story-<id>/traces.ndjson`,
 * but the AC stores the canonical fixtures under
 * `tests/.../fixtures/hotspot-epic/story-*\/traces.ndjson` — `hotspot-epic`
 * stands in for the Epic directory itself. To honour that path
 * verbatim while still feeding the detector the layout it expects, we
 * materialise a per-test scratch tempRoot and copy the canonical
 * fixture tree into `<scratch>/epic-<EPIC_ID>/story-*`.
 */
async function materializeFixtureTempRoot(scratchRoot) {
  const epicDir = path.join(scratchRoot, `epic-${EPIC_ID}`);
  await fs.mkdir(epicDir, { recursive: true });
  const storyDirs = await fs.readdir(HOTSPOT_FIXTURE_DIR, {
    withFileTypes: true,
  });
  for (const ent of storyDirs) {
    if (!ent.isDirectory()) continue;
    const src = path.join(HOTSPOT_FIXTURE_DIR, ent.name);
    const dst = path.join(epicDir, ent.name);
    await fs.mkdir(dst, { recursive: true });
    const traces = path.join(src, 'traces.ndjson');
    try {
      await fs.copyFile(traces, path.join(dst, 'traces.ndjson'));
    } catch {
      // Story dir without a traces.ndjson is allowed; skip.
    }
  }
  return scratchRoot;
}

beforeEach(() => {
  scratchDir = mkdtempSync(path.join(tmpdir(), 'hotspot-detector-'));
});

afterEach(() => {
  rmSync(scratchDir, { recursive: true, force: true });
});

describe('detectHotspot — barrel resolves', () => {
  it('exports detectHotspot and nearestRankP95 from the detectors barrel', () => {
    assert.equal(typeof detectHotspotFromBarrel, 'function');
    assert.equal(detectHotspotFromBarrel, detectHotspot);
    assert.equal(typeof nearestRankP95FromBarrel, 'function');
    assert.equal(nearestRankP95FromBarrel, nearestRankP95);
  });
});

describe('nearestRankP95 — fixed-input vectors', () => {
  it('returns 10 for [1,2,3,4,5,6,7,8,9,10] (idx = ceil(9.5)-1 = 9)', () => {
    assert.equal(nearestRankP95([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), 10);
  });

  it('returns 10 for the single-element [10] (idx = ceil(0.95)-1 = 0)', () => {
    assert.equal(nearestRankP95([10]), 10);
  });

  it('returns 0 for an empty array (defensive)', () => {
    assert.equal(nearestRankP95([]), 0);
  });

  it('is order-independent (sorts internally)', () => {
    assert.equal(nearestRankP95([10, 1, 9, 2, 8, 3, 7, 4, 6, 5]), 10);
  });
});

describe('detectHotspot — synthetic three-Story Epic fixture', () => {
  beforeEach(async () => {
    await materializeFixtureTempRoot(scratchDir);
  });

  it('emits exactly one hotspot for the cross-Story file', async () => {
    const events = await detectHotspot({
      epicId: EPIC_ID,
      multiplier: 0.5,
      tempRoot: scratchDir,
    });
    assert.equal(events.length, 1, 'exactly one hotspot signal');
    const [evt] = events;
    assert.equal(evt.details.targetHash, HOTSPOT_HASH);
    assert.equal(evt.details.storiesAffected, 3);
    assert.equal(evt.details.totalEdits, 15);
  });

  it('does NOT emit hotspots for files appearing in only one Story (even when their counts are high)', async () => {
    const events = await detectHotspot({
      epicId: EPIC_ID,
      multiplier: 0.5,
      tempRoot: scratchDir,
    });
    const emittedHashes = events.map((e) => e.details.targetHash);
    assert.ok(
      !emittedHashes.includes(STORY1_LOCAL_HASH),
      `single-Story hash bb… (6 edits in story-1 only) must not emit; got ${emittedHashes.join(', ')}`,
    );
    assert.ok(
      !emittedHashes.includes(STORY2_LOCAL_HASH),
      `single-Story hash cc… (6 edits in story-2 only) must not emit; got ${emittedHashes.join(', ')}`,
    );
  });

  it('does NOT emit for the cross-Story filler hash whose total is below threshold', async () => {
    const events = await detectHotspot({
      epicId: EPIC_ID,
      multiplier: 0.5,
      tempRoot: scratchDir,
    });
    const emittedHashes = events.map((e) => e.details.targetHash);
    assert.ok(
      !emittedHashes.includes(FILLER_HASH),
      'cross-Story filler dd… (2 edits) is in the percentile pool but below threshold and must not emit',
    );
  });

  it('emits a SignalEvent matching the schema envelope and the documented details payload', async () => {
    const events = await detectHotspot({
      epicId: EPIC_ID,
      multiplier: 0.5,
      tempRoot: scratchDir,
    });
    const [evt] = events;

    // Envelope (canonical fields per signal-event.schema.json)
    assert.equal(typeof evt.ts, 'string');
    assert.match(evt.ts, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(evt.kind, 'hotspot');
    assert.deepEqual(evt.source, { tool: 'hotspot-detector' });
    assert.equal(evt.epicId, EPIC_ID);

    // Per-kind details
    assert.equal(typeof evt.details, 'object');
    assert.equal(evt.details.targetHash, HOTSPOT_HASH);
    assert.equal(typeof evt.details.totalEdits, 'number');
    assert.equal(typeof evt.details.storiesAffected, 'number');
    assert.equal(typeof evt.details.p95Threshold, 'number');
    assert.equal(evt.details.multiplier, 0.5);
  });

  it('records a p95Threshold consistent with the cross-Story-only pool', async () => {
    // Pool of cross-Story totalEdits values: [aa=15, dd=2] → sorted [2, 15].
    // Nearest-rank p95 idx = ceil(0.95*2)-1 = 1 → 15. Threshold = 15 * 0.5 = 7.5.
    const events = await detectHotspot({
      epicId: EPIC_ID,
      multiplier: 0.5,
      tempRoot: scratchDir,
    });
    const [evt] = events;
    assert.equal(evt.details.p95Threshold, 7.5);
  });

  it('returns [] when multiplier pushes the threshold above the hotspot edit count', async () => {
    // multiplier 1.25 → threshold 18.75. aa total is 15, so no emission.
    const events = await detectHotspot({
      epicId: EPIC_ID,
      multiplier: 1.25,
      tempRoot: scratchDir,
    });
    assert.deepEqual(events, []);
  });
});

describe('detectHotspot — empty Epic temp dir', () => {
  it('returns [] when temp/epic-<eid>/ does not exist', async () => {
    // Scratch dir contains nothing — no epic-<id>/ subdir at all.
    const events = await detectHotspot({
      epicId: EPIC_ID,
      multiplier: 1.25,
      tempRoot: scratchDir,
    });
    assert.deepEqual(events, []);
  });

  it('returns [] when temp/epic-<eid>/ exists but contains no Story directories', async () => {
    const epicDir = path.join(scratchDir, `epic-${EPIC_ID}`);
    await fs.mkdir(epicDir, { recursive: true });
    // Add a non-story file to prove the regex filter holds.
    await fs.writeFile(path.join(epicDir, 'manifest.md'), '# not a story\n');
    const events = await detectHotspot({
      epicId: EPIC_ID,
      multiplier: 0.5,
      tempRoot: scratchDir,
    });
    assert.deepEqual(events, []);
  });

  it('returns [] when every Story dir is empty (no traces.ndjson at all)', async () => {
    const epicDir = path.join(scratchDir, `epic-${EPIC_ID}`);
    await fs.mkdir(path.join(epicDir, 'story-1'), { recursive: true });
    await fs.mkdir(path.join(epicDir, 'story-2'), { recursive: true });
    const events = await detectHotspot({
      epicId: EPIC_ID,
      multiplier: 0.5,
      tempRoot: scratchDir,
    });
    assert.deepEqual(events, []);
  });
});

describe('detectHotspot — argument validation', () => {
  it('throws TypeError when args is not an object', async () => {
    await assert.rejects(() => detectHotspot(null), TypeError);
    await assert.rejects(() => detectHotspot(undefined), TypeError);
  });

  it('throws RangeError for non-positive epicId', async () => {
    await assert.rejects(
      () => detectHotspot({ epicId: 0, multiplier: 1.25 }),
      RangeError,
    );
    await assert.rejects(
      () => detectHotspot({ epicId: -3, multiplier: 1.25 }),
      RangeError,
    );
    await assert.rejects(
      () => detectHotspot({ epicId: 1.5, multiplier: 1.25 }),
      RangeError,
    );
  });

  it('throws RangeError for non-positive or non-finite multiplier', async () => {
    await assert.rejects(
      () => detectHotspot({ epicId: EPIC_ID, multiplier: 0 }),
      RangeError,
    );
    await assert.rejects(
      () => detectHotspot({ epicId: EPIC_ID, multiplier: -1 }),
      RangeError,
    );
    await assert.rejects(
      () =>
        detectHotspot({
          epicId: EPIC_ID,
          multiplier: Number.POSITIVE_INFINITY,
        }),
      RangeError,
    );
  });

  it('throws TypeError when tempRoot is provided but not a non-empty string', async () => {
    await assert.rejects(
      () => detectHotspot({ epicId: EPIC_ID, multiplier: 1, tempRoot: '' }),
      TypeError,
    );
    await assert.rejects(
      () => detectHotspot({ epicId: EPIC_ID, multiplier: 1, tempRoot: 42 }),
      TypeError,
    );
  });
});

describe('detectHotspot — nowFn clock seam (Story #3329)', () => {
  beforeEach(async () => {
    await materializeFixtureTempRoot(scratchDir);
  });

  it('stamps the emission with the injected nowFn return value', async () => {
    const FIXED = '2026-01-02T03:04:05.678Z';
    const events = await detectHotspot({
      epicId: EPIC_ID,
      multiplier: 0.5,
      tempRoot: scratchDir,
      nowFn: () => FIXED,
    });
    assert.equal(events.length, 1);
    assert.equal(events[0].ts, FIXED);
  });

  it('invokes nowFn exactly once per detect call', async () => {
    let calls = 0;
    const events = await detectHotspot({
      epicId: EPIC_ID,
      multiplier: 0.5,
      tempRoot: scratchDir,
      nowFn: () => {
        calls += 1;
        return '2026-01-02T03:04:05.678Z';
      },
    });
    assert.equal(events.length, 1);
    assert.equal(calls, 1, 'nowFn should be called once per detect call');
  });

  it('defaults to a real ISO clock when nowFn is omitted', async () => {
    const events = await detectHotspot({
      epicId: EPIC_ID,
      multiplier: 0.5,
      tempRoot: scratchDir,
    });
    assert.equal(events.length, 1);
    assert.match(events[0].ts, /^\d{4}-\d{2}-\d{2}T/);
  });

  it('throws TypeError when nowFn is provided but not a function', async () => {
    await assert.rejects(
      () =>
        detectHotspot({
          epicId: EPIC_ID,
          multiplier: 0.5,
          tempRoot: scratchDir,
          nowFn: 'not-a-function',
        }),
      TypeError,
    );
  });
});

describe('detectHotspot — fixture-size contract (privacy: < 4KB each)', () => {
  it('keeps every fixture file under 4KB to enforce literal-hex hash discipline', () => {
    const fixtures = [
      path.join(HOTSPOT_FIXTURE_DIR, 'story-1', 'traces.ndjson'),
      path.join(HOTSPOT_FIXTURE_DIR, 'story-2', 'traces.ndjson'),
      path.join(HOTSPOT_FIXTURE_DIR, 'story-3', 'traces.ndjson'),
    ];
    for (const p of fixtures) {
      const { size } = statSync(p);
      assert.ok(
        size < 4 * 1024,
        `fixture ${p} is ${size} bytes; must be < 4096`,
      );
    }
  });
});
