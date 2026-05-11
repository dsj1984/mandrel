import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it, mock } from 'node:test';

import {
  epicSnapshotPathFor,
  forkMainToEpic,
  regenerateMainFromTree,
} from '../../.agents/scripts/lib/baseline-snapshot.js';

/**
 * Story #1396 (Epic #1386). Direct unit coverage for the per-Epic baseline
 * lifecycle helpers. Both helpers are dependency-injection-friendly so these
 * tests never touch the real `baselines/*.json` on disk — the fs surface is
 * replaced by an in-memory Map shim and the scoring + writer helpers are
 * stubbed.
 */

function makeFsShim(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    existsSync(p) {
      return store.has(p);
    },
    readFileSync(p) {
      if (!store.has(p)) {
        const err = new Error(`ENOENT: ${p}`);
        err.code = 'ENOENT';
        throw err;
      }
      return store.get(p);
    },
    writeFileSync(p, bytes) {
      store.set(p, bytes);
    },
    mkdirSync() {
      // shim — directory tracking is irrelevant for byte-equality checks
    },
  };
}

function silentLogger() {
  return {
    info: mock.fn(() => {}),
    warn: mock.fn(() => {}),
  };
}

const FAKE_CWD = path.resolve('/tmp/repo-1396');

function abs(...segments) {
  return path.resolve(FAKE_CWD, ...segments);
}

const BASELINES_RESOLVED = {
  maintainability: { path: 'baselines/maintainability.json' },
  crap: { path: 'baselines/crap.json' },
};

const QUALITY_RESOLVED = {
  maintainability: { targetDirs: ['.agents/scripts'] },
  crap: { targetDirs: ['.agents/scripts'], requireCoverage: true },
};

describe('epicSnapshotPathFor', () => {
  it('renders <cwd>/baselines/epic/<id>/<kind>.json absolute path', () => {
    const p = epicSnapshotPathFor({
      epicId: 1386,
      kind: 'maintainability',
      cwd: FAKE_CWD,
    });
    assert.match(p, /baselines[\\/]epic[\\/]1386[\\/]maintainability\.json$/);
  });

  it('rejects bad epicId', () => {
    assert.throws(() =>
      epicSnapshotPathFor({ epicId: 0, kind: 'crap', cwd: FAKE_CWD }),
    );
    assert.throws(() =>
      epicSnapshotPathFor({ epicId: -1, kind: 'crap', cwd: FAKE_CWD }),
    );
  });

  it('rejects unknown kind', () => {
    assert.throws(() =>
      epicSnapshotPathFor({ epicId: 1, kind: 'lint', cwd: FAKE_CWD }),
    );
  });
});

describe('forkMainToEpic', () => {
  it('writes both baselines under baselines/epic/<id>/ on first run', () => {
    const miSrc = `${JSON.stringify({ '.agents/scripts/foo.js': 90 }, null, 2)}\n`;
    const crapSrc = `${JSON.stringify({ rows: [], $schema: 'x' }, null, 2)}\n`;
    const miPath = abs('baselines/maintainability.json');
    const crapPath = abs('baselines/crap.json');
    const fsImpl = makeFsShim({
      [miPath]: miSrc,
      [crapPath]: crapSrc,
    });
    const logger = silentLogger();
    const out = forkMainToEpic({
      epicId: 1386,
      cwd: FAKE_CWD,
      resolveConfig: () => ({ agentSettings: {} }),
      getBaselines: () => BASELINES_RESOLVED,
      logger,
      fsImpl,
    });
    assert.equal(out.epicId, 1386);
    assert.equal(out.results.length, 2);
    for (const r of out.results) {
      assert.equal(r.written, true, `${r.kind} should be written`);
      assert.equal(r.reason, 'fresh');
    }
    const miDest = epicSnapshotPathFor({
      epicId: 1386,
      kind: 'maintainability',
      cwd: FAKE_CWD,
    });
    const crapDest = epicSnapshotPathFor({
      epicId: 1386,
      kind: 'crap',
      cwd: FAKE_CWD,
    });
    assert.equal(
      fsImpl.store.get(miDest),
      miSrc,
      'maintainability bytes copied verbatim',
    );
    assert.equal(
      fsImpl.store.get(crapDest),
      crapSrc,
      'crap bytes copied verbatim',
    );
  });

  it('is idempotent — re-running with identical source content does not rewrite', () => {
    const miSrc = `${JSON.stringify({ a: 1 }, null, 2)}\n`;
    const crapSrc = `${JSON.stringify({ rows: [] }, null, 2)}\n`;
    const miPath = abs('baselines/maintainability.json');
    const crapPath = abs('baselines/crap.json');
    const miDest = epicSnapshotPathFor({
      epicId: 9,
      kind: 'maintainability',
      cwd: FAKE_CWD,
    });
    const crapDest = epicSnapshotPathFor({
      epicId: 9,
      kind: 'crap',
      cwd: FAKE_CWD,
    });
    const fsImpl = makeFsShim({
      [miPath]: miSrc,
      [crapPath]: crapSrc,
      [miDest]: miSrc,
      [crapDest]: crapSrc,
    });
    const out = forkMainToEpic({
      epicId: 9,
      cwd: FAKE_CWD,
      resolveConfig: () => ({ agentSettings: {} }),
      getBaselines: () => BASELINES_RESOLVED,
      logger: silentLogger(),
      fsImpl,
    });
    for (const r of out.results) {
      assert.equal(r.written, false, `${r.kind} should be skipped`);
      assert.equal(r.reason, 'idempotent');
    }
  });

  it('emits a warn and skips when source baseline is missing', () => {
    const fsImpl = makeFsShim({});
    const logger = silentLogger();
    const out = forkMainToEpic({
      epicId: 42,
      cwd: FAKE_CWD,
      resolveConfig: () => ({ agentSettings: {} }),
      getBaselines: () => BASELINES_RESOLVED,
      logger,
      fsImpl,
    });
    for (const r of out.results) {
      assert.equal(r.written, false);
      assert.equal(r.reason, 'source-missing');
    }
    assert.equal(logger.warn.mock.callCount(), 2);
  });

  it('rejects bad epicId', () => {
    assert.throws(() =>
      forkMainToEpic({
        epicId: 0,
        cwd: FAKE_CWD,
        resolveConfig: () => ({ agentSettings: {} }),
        getBaselines: () => BASELINES_RESOLVED,
        fsImpl: makeFsShim(),
      }),
    );
  });
});

describe('regenerateMainFromTree', () => {
  it('returns didChange=false when scoring matches the existing tracked baselines', async () => {
    const miPath = abs('baselines/maintainability.json');
    const crapPath = abs('baselines/crap.json');
    const initial = '{"x":1}\n';
    const fsImpl = makeFsShim({
      [miPath]: initial,
      [crapPath]: initial,
    });

    const out = await regenerateMainFromTree({
      cwd: FAKE_CWD,
      resolveConfig: () => ({ agentSettings: {} }),
      getBaselines: () => BASELINES_RESOLVED,
      getQuality: () => QUALITY_RESOLVED,
      logger: silentLogger(),
      fsImpl,
      scanDirectoryFn: () => [],
      calculateAllFn: async () => ({}),
      saveMaintainabilityFn: () => {
        // no-op writer — leaves fs store intact so the byte-equality check
        // resolves to "unchanged"
      },
      scanAndScoreFn: async () => ({ rows: [] }),
      buildBaselineEnvelopeFn: () => ({ rows: [] }),
      saveCrapFn: () => {
        // no-op writer
      },
      loadCoverageFn: () => ({}),
      resolveEscomplexVersionFn: () => '0.1.0',
      resolveTsTranspilerVersionFn: () => '5.9.3',
    });

    assert.equal(out.didChange, false);
    for (const f of out.files) {
      assert.equal(f.didChange, false);
      assert.equal(f.reason, 'unchanged');
    }
  });

  it('returns didChange=true and reports updated files when scoring drifts', async () => {
    const miPath = abs('baselines/maintainability.json');
    const crapPath = abs('baselines/crap.json');
    const fsImpl = makeFsShim({
      [miPath]: '{"old":1}\n',
      [crapPath]: '{"old":true}\n',
    });
    const out = await regenerateMainFromTree({
      cwd: FAKE_CWD,
      resolveConfig: () => ({ agentSettings: {} }),
      getBaselines: () => BASELINES_RESOLVED,
      getQuality: () => QUALITY_RESOLVED,
      logger: silentLogger(),
      fsImpl,
      scanDirectoryFn: () => [],
      calculateAllFn: async () => ({ '.agents/scripts/foo.js': 92 }),
      saveMaintainabilityFn: (scores, p) => {
        fsImpl.writeFileSync(p, `${JSON.stringify(scores, null, 2)}\n`);
      },
      scanAndScoreFn: async () => ({ rows: [] }),
      buildBaselineEnvelopeFn: () => ({ rows: [], escomplexVersion: '0.1.0' }),
      saveCrapFn: (envelope, opts) => {
        fsImpl.writeFileSync(
          opts.baselinePath,
          `${JSON.stringify(envelope, null, 2)}\n`,
        );
      },
      loadCoverageFn: () => ({}),
      resolveEscomplexVersionFn: () => '0.1.0',
      resolveTsTranspilerVersionFn: () => '5.9.3',
    });
    assert.equal(out.didChange, true);
    const updated = out.files.filter((f) => f.didChange);
    assert.equal(updated.length, 2);
  });

  it('skips crap regeneration when coverage is missing under requireCoverage', async () => {
    const miPath = abs('baselines/maintainability.json');
    const fsImpl = makeFsShim({ [miPath]: '{}\n' });
    const logger = silentLogger();
    const out = await regenerateMainFromTree({
      cwd: FAKE_CWD,
      resolveConfig: () => ({ agentSettings: {} }),
      getBaselines: () => BASELINES_RESOLVED,
      getQuality: () => QUALITY_RESOLVED,
      logger,
      fsImpl,
      scanDirectoryFn: () => [],
      calculateAllFn: async () => ({}),
      saveMaintainabilityFn: () => {},
      scanAndScoreFn: async () => {
        throw new Error('should not be called when coverage is missing');
      },
      buildBaselineEnvelopeFn: () => ({}),
      saveCrapFn: () => {
        throw new Error('should not be called when coverage is missing');
      },
      loadCoverageFn: () => null,
      resolveEscomplexVersionFn: () => '0.1.0',
      resolveTsTranspilerVersionFn: () => '5.9.3',
    });
    const crapEntry = out.files.find((f) => f.kind === 'crap');
    assert.ok(crapEntry, 'crap entry should be present');
    assert.equal(crapEntry.didChange, false);
    assert.equal(crapEntry.reason, 'no-coverage');
    assert.equal(logger.warn.mock.callCount(), 1);
  });
});
