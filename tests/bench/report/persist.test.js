// tests/bench/report/persist.test.js
//
// Unit tier (pure logic + injected I/O, no real disk) for the append-only
// scorecard store (Epic #4211, Story #4218). Exercises bench/report/persist.js
// against the Story's binding acceptance item:
//   "writes each scorecard stamped with model, framework-version, and env to a
//    stable append-only store."
// Covers: stamp validation, NDJSON serialization round-trip, append-only
// semantics (never rewrites), directory creation, cohort grouping, and the
// rejection of un-stamped / wrong-version records.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  appendScorecards,
  cohortKey,
  groupByCohort,
  missingStampFields,
  parseStore,
  readStore,
  serializeScorecards,
} from '../../../bench/report/persist.js';

const MODEL = { id: 'claude-opus-4-8[1m]' };
const ENV = { node: 'v24.16.0', os: 'darwin' };

function card(overrides = {}) {
  return {
    schemaVersion: 1,
    runId: 'hw-m-r1',
    timestamp: '2026-06-16T19:42:11.000Z',
    model: MODEL,
    frameworkVersion: '1.70.0',
    env: ENV,
    scenario: 'hello-world',
    arm: 'mandrel',
    dimensions: {
      quality: { score: 1, frozenSuitePassRate: 1 },
      planningFidelity: { score: 0.9 },
      autonomy: { score: 1, hitlStops: 0, blockedEvents: 0, manualRescues: 0 },
      efficiency: { wallClockMs: 600000, totalTokens: 180000, dispatches: 2 },
      overheadRatio: { tokenRatio: 4.2 },
    },
    ...overrides,
  };
}

/**
 * In-memory filesystem double: a Map of path → contents, with append/read/
 * exists/mkdir shims that record what was written.
 */
function fakeFs(initial = {}) {
  const files = new Map(Object.entries(initial));
  const dirs = new Set();
  return {
    files,
    dirs,
    appendFileImpl(path, data) {
      files.set(path, (files.get(path) ?? '') + data);
    },
    existsImpl(path) {
      return files.has(path) || dirs.has(path);
    },
    mkdirImpl(path) {
      dirs.add(path);
    },
    readFileImpl(path) {
      if (!files.has(path)) throw new Error(`ENOENT: ${path}`);
      return files.get(path);
    },
  };
}

describe('missingStampFields', () => {
  it('returns empty for a fully-stamped scorecard', () => {
    assert.deepEqual(missingStampFields(card()), []);
  });

  it('lists every missing stamp field', () => {
    const bare = { dimensions: {} };
    const missing = missingStampFields(bare);
    assert.ok(missing.includes('model.id'));
    assert.ok(missing.includes('frameworkVersion'));
    assert.ok(missing.includes('env.node'));
    assert.ok(missing.includes('env.os'));
    assert.ok(missing.includes('runId'));
  });

  it('flags a partial stamp (missing env.os only)', () => {
    const sc = card({ env: { node: 'v24.16.0' } });
    assert.deepEqual(missingStampFields(sc), ['env.os']);
  });
});

describe('cohortKey', () => {
  it('builds a stable model|fw|node|os key', () => {
    assert.equal(
      cohortKey(card()),
      'claude-opus-4-8[1m]|1.70.0|v24.16.0|darwin',
    );
  });

  it('keys differ when the framework version differs', () => {
    assert.notEqual(
      cohortKey(card({ frameworkVersion: '1.70.0' })),
      cohortKey(card({ frameworkVersion: '1.71.0' })),
    );
  });
});

describe('serializeScorecards', () => {
  it('serializes one record per line ending in a single newline', () => {
    const block = serializeScorecards([
      card({ runId: 'a' }),
      card({ runId: 'b' }),
    ]);
    const lines = block.split('\n').filter((l) => l.length > 0);
    assert.equal(lines.length, 2);
    assert.ok(block.endsWith('\n'));
    assert.equal(JSON.parse(lines[0]).runId, 'a');
  });

  it('stamps schemaVersion when the caller omitted it', () => {
    const { schemaVersion, ...noVersion } = card();
    void schemaVersion;
    const block = serializeScorecards([noVersion]);
    assert.equal(JSON.parse(block.trim()).schemaVersion, 1);
  });

  it('rejects an un-stamped scorecard (never persists incomparable data)', () => {
    assert.throws(
      () => serializeScorecards([{ dimensions: {} }]),
      /missing required stamp field/,
    );
  });

  it('rejects a scorecard with an unexpected schemaVersion', () => {
    assert.throws(
      () => serializeScorecards([card({ schemaVersion: 2 })]),
      /schemaVersion 2, expected 1/,
    );
  });

  it('returns an empty string for an empty batch', () => {
    assert.equal(serializeScorecards([]), '');
  });

  it('throws on a non-array', () => {
    assert.throws(() => serializeScorecards(null), TypeError);
  });
});

describe('parseStore', () => {
  it('round-trips serialized records', () => {
    const block = serializeScorecards([
      card({ runId: 'a' }),
      card({ runId: 'b' }),
    ]);
    const parsed = parseStore(block);
    assert.equal(parsed.length, 2);
    assert.equal(parsed[1].runId, 'b');
  });

  it('skips blank lines', () => {
    assert.equal(parseStore('\n\n').length, 0);
  });

  it('throws with a line number on malformed JSON', () => {
    assert.throws(() => parseStore('{ok:1}'), /line 1/);
  });
});

describe('appendScorecards — append-only store', () => {
  it('writes a batch and reports the count + bytes', () => {
    const fs = fakeFs();
    const res = appendScorecards(
      {
        storePath: 'temp/bench/store.ndjson',
        scorecards: [card({ runId: 'a' })],
      },
      fs,
    );
    assert.equal(res.appended, 1);
    assert.ok(res.bytesAppended > 0);
    assert.equal(parseStore(fs.files.get('temp/bench/store.ndjson')).length, 1);
  });

  it('creates the parent directory on first write', () => {
    const fs = fakeFs();
    appendScorecards(
      { storePath: 'temp/bench/nested/store.ndjson', scorecards: [card()] },
      fs,
    );
    assert.ok(fs.dirs.has('temp/bench/nested'));
  });

  it('APPENDS to an existing store rather than rewriting it', () => {
    const fs = fakeFs();
    appendScorecards(
      { storePath: 's.ndjson', scorecards: [card({ runId: 'first' })] },
      fs,
    );
    appendScorecards(
      { storePath: 's.ndjson', scorecards: [card({ runId: 'second' })] },
      fs,
    );
    const all = parseStore(fs.files.get('s.ndjson'));
    assert.equal(all.length, 2);
    assert.deepEqual(
      all.map((r) => r.runId),
      ['first', 'second'],
    );
  });

  it('rejects the whole batch atomically when one record is un-stamped', () => {
    const fs = fakeFs();
    assert.throws(
      () =>
        appendScorecards(
          {
            storePath: 's.ndjson',
            scorecards: [card({ runId: 'ok' }), { dimensions: {} }],
          },
          fs,
        ),
      /missing required stamp field/,
    );
    // Nothing was written — the bad batch never touched the file.
    assert.equal(fs.files.has('s.ndjson'), false);
  });

  it('is a no-op for an empty batch', () => {
    const fs = fakeFs();
    const res = appendScorecards({ storePath: 's.ndjson', scorecards: [] }, fs);
    assert.equal(res.appended, 0);
    assert.equal(fs.files.has('s.ndjson'), false);
  });

  it('throws without a storePath', () => {
    assert.throws(() => appendScorecards({ scorecards: [] }), TypeError);
  });
});

describe('readStore', () => {
  it('reads every persisted scorecard back', () => {
    const fs = fakeFs();
    appendScorecards(
      {
        storePath: 's.ndjson',
        scorecards: [card({ runId: 'a' }), card({ runId: 'b' })],
      },
      fs,
    );
    const back = readStore({ storePath: 's.ndjson' }, fs);
    assert.equal(back.length, 2);
    assert.equal(back[0].model.id, 'claude-opus-4-8[1m]');
  });

  it('reads a non-existent store as empty', () => {
    const fs = fakeFs();
    assert.deepEqual(readStore({ storePath: 'missing.ndjson' }, fs), []);
  });
});

describe('groupByCohort', () => {
  it('groups records by their (model, fw, env) cohort key', () => {
    const records = [
      card({ runId: 'a', frameworkVersion: '1.70.0' }),
      card({ runId: 'b', frameworkVersion: '1.70.0' }),
      card({ runId: 'c', frameworkVersion: '1.71.0' }),
    ];
    const grouped = groupByCohort(records);
    assert.equal(grouped.size, 2);
    const v170 = grouped.get('claude-opus-4-8[1m]|1.70.0|v24.16.0|darwin');
    assert.equal(v170.length, 2);
  });

  it('preserves append order within a cohort', () => {
    const grouped = groupByCohort([
      card({ runId: 'first' }),
      card({ runId: 'second' }),
    ]);
    const only = [...grouped.values()][0];
    assert.deepEqual(
      only.map((r) => r.runId),
      ['first', 'second'],
    );
  });

  it('throws on a non-array', () => {
    assert.throws(() => groupByCohort(null), TypeError);
  });
});
