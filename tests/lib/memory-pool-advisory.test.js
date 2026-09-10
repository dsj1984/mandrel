/**
 * tests/lib/memory-pool-advisory.test.js — Story #4919
 *
 * Covers the `/mandrel-plan` Phase 0 memory-hygiene advisory that replaced the retired
 * memory-freshness scanner: pool resolution (override + cwd-slug), the
 * fail-soft absent path, and each recommend branch.
 *
 * Story #5182 replaced the absolute entry ceiling with growth since the last
 * pass, so the arms asserted here are age and growth — and the case that
 * earns its own test is the pre-#5182 stamp, whose missing `entryCount` must
 * read as *unmeasured* growth rather than as a never-consolidated pool.
 *
 * Story #5285 added a third, independent arm — the index's byte size against
 * the harness cap — plus the future-dated-stamp guard. Both are asserted on a
 * pool that is otherwise perfectly quiet (fresh stamp, zero growth), because
 * independence is the whole point: an arm that only fires alongside another
 * adds nothing.
 *
 * Everything is reached through `buildMemoryPoolAdvisory`, the module's only
 * export — the slug rule and the thresholds are asserted by their observable
 * effect rather than by importing the helpers, because exporting one solely
 * for a test would add a `dead-exports-production` row.
 *
 * Every case runs against an in-memory `fsImpl` seam with an injected `now`
 * and `homedir` — no child processes, no real home directory, no clock
 * dependence. The advisory spawns nothing by design (the retired scanner's
 * `gh` probes were the reason it could hang), so a test that needed a
 * subprocess would itself be evidence of a regression.
 */

import assert from 'node:assert/strict';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { buildMemoryPoolAdvisory } from '../../.agents/scripts/lib/orchestration/planning/memory-pool-advisory.js';

const HOME = '/home/tester';
const CWD = '/Users/dev/Projects/demo.app';
/** The slug rule under test: every `/` and `.` in the cwd becomes `-`. */
const POOL = path.join(
  HOME,
  '.claude',
  'projects',
  '-Users-dev-Projects-demo-app',
  'memory',
);
const NOW = '2026-08-02T12:00:00.000Z';
const STAMP = '.consolidation-stamp.json';
const DAY_MS = 86_400_000;

/**
 * Build a minimal node:fs-compatible seam over `{ path: contents }` maps.
 * Anything absent throws ENOENT the way the real `fs` does, so the module's
 * own try/catch paths are exercised rather than bypassed.
 */
function makeFs({ dirs = {}, files = {} } = {}) {
  return {
    statSync(p) {
      if (Object.hasOwn(dirs, p)) return { isDirectory: () => true, size: 0 };
      if (Object.hasOwn(files, p)) {
        return {
          isDirectory: () => false,
          size: Buffer.byteLength(String(files[p])),
        };
      }
      throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
    },
    readdirSync(p) {
      if (!Object.hasOwn(dirs, p)) {
        throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
      }
      return dirs[p];
    },
    readFileSync(p) {
      if (!Object.hasOwn(files, p)) {
        throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
      }
      return files[p];
    },
  };
}

/**
 * A pool at `dir` holding `count` entries plus the index, optionally stamped.
 *
 * `indexBytes` plants a `MEMORY.md` of exactly that byte length. Omitting it
 * leaves the index listed in the directory but absent as a file, which is the
 * fixture every pre-#5285 case used and which reads as an unstat-able index —
 * so the byte arm stays silent unless a case opts in.
 */
function poolWith({ count, stamp, indexBytes, dir = POOL }) {
  const names = Array.from({ length: count }, (_, i) => `memory-${i}.md`);
  const files = {};
  if (stamp !== undefined) files[path.join(dir, STAMP)] = stamp;
  if (indexBytes !== undefined) {
    files[path.join(dir, 'MEMORY.md')] = 'x'.repeat(indexBytes);
  }
  return makeFs({ dirs: { [dir]: ['MEMORY.md', ...names] }, files });
}

/**
 * A stamp `days` old. `entryCount` is the growth baseline the pass left
 * behind; omitting it reproduces a pre-#5182 stamp exactly.
 */
const stampedAgo = (days, entryCount) =>
  JSON.stringify({
    lastConsolidatedAt: new Date(Date.parse(NOW) - days * DAY_MS).toISOString(),
    ...(entryCount === undefined ? {} : { entryCount }),
  });

const advisory = (opts) =>
  buildMemoryPoolAdvisory({
    cwd: CWD,
    env: {},
    homedir: HOME,
    now: NOW,
    ...opts,
  });

describe('memory pool resolution (Story #4919)', () => {
  it('finds the pool at the cwd-slug path — every / and . becomes -', () => {
    // POOL is spelled out from the slug rule; finding entries there proves the
    // module derived the same path from CWD.
    const result = advisory({ fsImpl: poolWith({ count: 3 }) });
    assert.equal(result.present, true);
    assert.equal(result.entryCount, 3, 'MEMORY.md is the index, not an entry');
  });

  it('resolves a dotted worktree segment the way the harness names it', () => {
    // Verified against a real ~/.claude/projects entry: the `/` before
    // `.claude-worktrees` and its leading `.` both become `-`, yielding `--`.
    const cwd =
      '/Users/dsj/Development/mandrel/.claude-worktrees/gifted-swirles';
    const dir = path.join(
      HOME,
      '.claude',
      'projects',
      '-Users-dsj-Development-mandrel--claude-worktrees-gifted-swirles',
      'memory',
    );
    const result = advisory({ cwd, fsImpl: poolWith({ count: 2, dir }) });
    assert.equal(result.present, true);
    assert.equal(result.entryCount, 2);
  });

  it('lets MANDREL_MEMORY_DIR win over the cwd-slug path', () => {
    const dir = '/tmp/override-pool';
    const result = advisory({
      env: { MANDREL_MEMORY_DIR: dir },
      fsImpl: poolWith({ count: 1, dir }),
    });
    assert.equal(result.present, true);
    assert.equal(result.entryCount, 1);
  });

  it('fails soft when there is no cwd to slugify', () => {
    const result = advisory({ cwd: '', fsImpl: poolWith({ count: 3 }) });
    assert.equal(result.present, false);
    assert.equal(result.recommend, false);
  });
});

describe('memory pool absent — fails soft (Story #4919)', () => {
  it('reports present:false and recommend:false when the directory does not exist', () => {
    const result = advisory({ fsImpl: makeFs() });
    assert.equal(result.present, false);
    assert.equal(result.recommend, false);
    assert.equal(result.entryCount, 0);
    assert.equal(result.lastConsolidatedAt, null);
    assert.ok(
      result.reasons.length > 0,
      'an absent pool must still explain itself',
    );
  });

  it('fails soft when the pool path is a file rather than a directory', () => {
    const result = advisory({
      fsImpl: makeFs({ files: { [POOL]: 'not a dir' } }),
    });
    assert.equal(result.present, false);
    assert.equal(result.recommend, false);
  });
});

describe('recommend branches (Story #4919)', () => {
  it('recommends when the pool has never been consolidated (no stamp)', () => {
    const result = advisory({ fsImpl: poolWith({ count: 3 }) });
    assert.equal(result.lastConsolidatedAt, null);
    assert.equal(result.recommend, true);
    assert.match(result.reasons.join(' '), /never been consolidated/);
  });

  it('recommends when the stamp is older than the 30-day threshold', () => {
    const stamp = stampedAgo(35);
    const result = advisory({ fsImpl: poolWith({ count: 3, stamp }) });
    assert.equal(result.recommend, true);
    assert.equal(
      result.lastConsolidatedAt,
      JSON.parse(stamp).lastConsolidatedAt,
    );
    assert.match(result.reasons.join(' '), /35 days ago/);
  });

  it('recommends on 25 entries written since the last pass, fresh stamp and all', () => {
    const result = advisory({
      fsImpl: poolWith({ count: 125, stamp: stampedAgo(1, 100) }),
    });
    assert.equal(result.recommend, true);
    assert.equal(result.entriesSinceConsolidation, 25);
    assert.match(
      result.reasons.join(' '),
      /25 entries written since the last consolidation \(at or over the 25-entry/,
    );
  });

  it('stays quiet for a large pool a pass just reviewed — size is not the signal', () => {
    // The defect Story #5182 fixed: a 163-entry pool that a consolidation
    // pass had just walked still recommended another one, forever, because
    // the old arm compared the pool's size to a fixed ceiling.
    const result = advisory({
      fsImpl: poolWith({ count: 163, stamp: stampedAgo(1, 163) }),
    });
    assert.equal(result.present, true);
    assert.equal(result.recommend, false);
    assert.equal(result.entriesSinceConsolidation, 0);
  });

  it('stays quiet at exactly the thresholds — neither is breached', () => {
    const result = advisory({
      fsImpl: poolWith({ count: 124, stamp: stampedAgo(30, 100) }),
    });
    assert.equal(result.present, true);
    assert.equal(result.recommend, false);
  });

  it('reports a pruning pass as negative growth rather than clamping it', () => {
    const result = advisory({
      fsImpl: poolWith({ count: 93, stamp: stampedAgo(1, 100) }),
    });
    assert.equal(result.recommend, false);
    assert.equal(result.entriesSinceConsolidation, -7);
  });

  it('honours caller-supplied thresholds over the defaults', () => {
    const result = advisory({
      fsImpl: poolWith({ count: 5, stamp: stampedAgo(2, 1) }),
      staleAfterDays: 1,
      growthDelta: 4,
    });
    assert.equal(result.recommend, true);
    assert.equal(result.reasons.length, 2, 'both thresholds should fire');
  });

  it('treats a malformed stamp as never-consolidated rather than throwing', () => {
    const result = advisory({
      fsImpl: poolWith({ count: 3, stamp: '{ not json' }),
    });
    assert.equal(result.recommend, true);
    assert.equal(result.lastConsolidatedAt, null);
  });

  it('does not recommend consolidating an empty pool', () => {
    const result = advisory({
      fsImpl: makeFs({ dirs: { [POOL]: ['MEMORY.md'] } }),
    });
    assert.equal(result.present, true);
    assert.equal(result.entryCount, 0);
    assert.equal(result.recommend, false);
  });
});

describe('a stamp with no entry count leaves growth unmeasured (Story #5182)', () => {
  it('fires neither the growth arm nor the never-consolidated reason', () => {
    // Every stamp written before #5182 has this shape. An operator DID review
    // this pool, so reading it as never-consolidated would be a lie — and
    // scoring growth from a zero baseline would count the whole pool as new.
    const result = advisory({
      fsImpl: poolWith({ count: 300, stamp: stampedAgo(1) }),
    });
    assert.equal(result.recommend, false);
    assert.equal(result.entriesSinceConsolidation, null);
    assert.equal(
      result.lastConsolidatedAt,
      JSON.parse(stampedAgo(1)).lastConsolidatedAt,
    );
    assert.match(result.reasons.join(' '), /growth is unmeasured/);
    assert.doesNotMatch(result.reasons.join(' '), /never been consolidated/);
  });

  it('still lets the age arm fire on such a stamp', () => {
    const result = advisory({
      fsImpl: poolWith({ count: 300, stamp: stampedAgo(45) }),
    });
    assert.equal(result.recommend, true);
    assert.equal(result.reasons.length, 1, 'only the age arm may speak');
    assert.match(result.reasons.join(' '), /45 days ago/);
  });

  it('treats a malformed entry count as unmeasured, never as zero', () => {
    const stamp = JSON.stringify({
      lastConsolidatedAt: new Date(Date.parse(NOW) - DAY_MS).toISOString(),
      entryCount: 'lots',
    });
    const result = advisory({ fsImpl: poolWith({ count: 300, stamp }) });
    assert.equal(result.recommend, false);
    assert.equal(result.entriesSinceConsolidation, null);
  });
});

describe('index byte arm (Story #5285)', () => {
  /** The size this repository's own index had when the arm was authored. */
  const OVERSIZE = 28_791;
  /** A fresh stamp with a matching baseline: age and growth both silent. */
  const QUIET_STAMP = stampedAgo(1, 5);

  it('recommends on an oversized index even when age and growth are quiet', () => {
    const result = advisory({
      fsImpl: poolWith({ count: 5, stamp: QUIET_STAMP, indexBytes: OVERSIZE }),
    });
    assert.equal(result.recommend, true);
    assert.equal(result.indexBytes, OVERSIZE);
    assert.equal(
      result.reasons.length,
      1,
      'the byte arm must speak alone — it is independent of the other two',
    );
    const reason = result.reasons[0];
    assert.match(reason, /28791 bytes/, 'the reason names the measured size');
    assert.match(
      reason,
      /4215 over the 24576-byte index ceiling/,
      'the reason names the overage against the ceiling',
    );
    assert.match(
      reason,
      /invisible to every session/,
      'the reason names the loss, not just the number',
    );
  });

  it('stays quiet on an index under the ceiling with a fresh stamp', () => {
    const result = advisory({
      fsImpl: poolWith({ count: 5, stamp: QUIET_STAMP, indexBytes: 20_000 }),
    });
    assert.equal(result.recommend, false);
    assert.equal(result.indexBytes, 20_000);
  });

  it('honours an injected ceiling, so the config key is not decorative', () => {
    const fsImpl = poolWith({
      count: 5,
      stamp: QUIET_STAMP,
      indexBytes: 20_000,
    });
    assert.equal(
      advisory({ fsImpl, indexByteCeiling: 10_000 }).recommend,
      true,
      'a tightened ceiling arms the arm the default leaves quiet',
    );
    assert.equal(
      advisory({ fsImpl, indexByteCeiling: 40_000 }).recommend,
      false,
    );
  });

  it('leaves the arm silent when the index cannot be stat-ed', () => {
    // An unreadable index is unmeasured, never small: reporting `indexBytes`
    // as 0 here would read as a healthy index and hide a real overage.
    const result = advisory({
      fsImpl: poolWith({ count: 5, stamp: QUIET_STAMP }),
    });
    assert.equal(result.indexBytes, null);
    assert.equal(result.recommend, false);
  });
});

describe('future-dated stamp (Story #5285)', () => {
  it('reads a stamp dated after now as unstamped and fires the never-consolidated reason', () => {
    // Scored as-is this yields a negative age, which silences the age arm for
    // as long as the clock stays behind the stamp — the one failure an
    // advisory cannot survive.
    const stamp = JSON.stringify({
      lastConsolidatedAt: new Date(Date.parse(NOW) + 5 * DAY_MS).toISOString(),
      entryCount: 5,
    });
    const result = advisory({ fsImpl: poolWith({ count: 5, stamp }) });
    assert.equal(result.lastConsolidatedAt, null, 'reported as unstamped');
    assert.equal(
      result.entriesSinceConsolidation,
      null,
      'a stamp that cannot be dated carries no growth baseline either',
    );
    assert.equal(result.recommend, true);
    assert.match(result.reasons.join(' '), /never been consolidated/);
  });

  it('accepts a stamp written at exactly now — equality is not the future', () => {
    const stamp = JSON.stringify({ lastConsolidatedAt: NOW, entryCount: 5 });
    const result = advisory({ fsImpl: poolWith({ count: 5, stamp }) });
    assert.equal(result.lastConsolidatedAt, NOW);
    assert.equal(result.recommend, false);
  });
});

describe('the advisory renders no per-entry verdict (Story #4919)', () => {
  it('exposes only counts and the stamp, never a staleness judgement', () => {
    // The retired scanner's defect was semantic: it marked an entry stale when
    // a cited issue was closed, which is exactly what a delivery retrospective
    // cites. Guard the replacement's shape so that verdict cannot creep back.
    const result = advisory({ fsImpl: poolWith({ count: 5 }) });
    assert.deepEqual(Object.keys(result).sort(), [
      'entriesSinceConsolidation',
      'entryCount',
      'indexBytes',
      'lastConsolidatedAt',
      'present',
      'reasons',
      'recommend',
    ]);
  });
});
