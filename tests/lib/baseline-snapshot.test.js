import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it, mock } from 'node:test';

import {
  commitSnapshotsToEpicBranch,
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
  it('renders <cwd>/temp/epic-<id>/baselines/<kind>.json absolute path', () => {
    const p = epicSnapshotPathFor({
      epicId: 1386,
      kind: 'maintainability',
      cwd: FAKE_CWD,
    });
    assert.match(
      p,
      /temp[\\/]epic-1386[\\/]baselines[\\/]maintainability\.json$/,
    );
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
  it('writes both baselines under temp/epic-<id>/baselines/ on first run', () => {
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

  // Story #2079 — defence-in-depth against worktree-relative path leakage in
  // the on-disk maintainability baseline. The scoring helper can hand back
  // keys that are either absolute (file scanner inside a worktree) or
  // relative-but-prefixed (resolver mismatch produces a `.worktrees/...` key
  // even when cwd ≠ worktree). Both shapes used to leak verbatim into the
  // flat-map baseline that ships in `baselines/maintainability.json` and
  // blocked subsequent close-validation runs on sibling Stories. The fix
  // routes every key through `path-canon` after the cwd-relative reduction
  // so the prefix is stripped regardless of upstream resolution accidents.
  it('canonicalises path-style worktree-prefixed keys before persisting maintainability scores', async () => {
    const miPath = abs('baselines/maintainability.json');
    const crapPath = abs('baselines/crap.json');
    const fsImpl = makeFsShim({
      [miPath]: '{}\n',
      [crapPath]: '{}\n',
    });
    let captured = null;
    await regenerateMainFromTree({
      cwd: FAKE_CWD,
      resolveConfig: () => ({ agentSettings: {} }),
      getBaselines: () => BASELINES_RESOLVED,
      getQuality: () => QUALITY_RESOLVED,
      logger: silentLogger(),
      fsImpl,
      scanDirectoryFn: () => [],
      calculateAllFn: async () => ({
        // Relative-but-prefixed shape — bug repro from Story #2029's close,
        // where the scoring resolver produced keys carrying the worktree
        // segment even though cwd was the main checkout.
        '.worktrees/story-2029/.agents/scripts/foo.js': 92,
        // Clean shape — passes through unchanged.
        '.agents/scripts/bar.js': 85,
      }),
      saveMaintainabilityFn: (scores) => {
        captured = scores;
      },
      scanAndScoreFn: async () => ({ rows: [] }),
      buildBaselineEnvelopeFn: () => ({ rows: [], escomplexVersion: '0.1.0' }),
      saveCrapFn: () => {},
      loadCoverageFn: () => ({}),
      resolveEscomplexVersionFn: () => '0.1.0',
      resolveTsTranspilerVersionFn: () => '5.9.3',
    });

    assert.ok(captured, 'saveMaintainabilityFn must have been invoked');
    const keys = Object.keys(captured);
    for (const k of keys) {
      assert.ok(
        !k.startsWith('.worktrees/'),
        `key must not carry .worktrees/ prefix; got "${k}"`,
      );
    }
    // The prefixed input collapses into the canonical key — preserves the score.
    assert.equal(captured['.agents/scripts/foo.js'], 92);
    assert.equal(captured['.agents/scripts/bar.js'], 85);
  });

  it('canonicalises absolute-into-worktree keys produced by an in-worktree file scanner', async () => {
    const miPath = abs('baselines/maintainability.json');
    const crapPath = abs('baselines/crap.json');
    const fsImpl = makeFsShim({
      [miPath]: '{}\n',
      [crapPath]: '{}\n',
    });
    let captured = null;
    await regenerateMainFromTree({
      cwd: FAKE_CWD,
      resolveConfig: () => ({ agentSettings: {} }),
      getBaselines: () => BASELINES_RESOLVED,
      getQuality: () => QUALITY_RESOLVED,
      logger: silentLogger(),
      fsImpl,
      scanDirectoryFn: () => [],
      calculateAllFn: async () => ({
        // Absolute path inside a worktree, with cwd as the main checkout —
        // `path.relative` returns `.worktrees/<workspace>/...`, which must
        // be stripped before the key reaches the on-disk baseline.
        [path.resolve(
          FAKE_CWD,
          '.worktrees/story-2029/.agents/scripts/baz.js',
        )]: 77,
      }),
      saveMaintainabilityFn: (scores) => {
        captured = scores;
      },
      scanAndScoreFn: async () => ({ rows: [] }),
      buildBaselineEnvelopeFn: () => ({ rows: [], escomplexVersion: '0.1.0' }),
      saveCrapFn: () => {},
      loadCoverageFn: () => ({}),
      resolveEscomplexVersionFn: () => '0.1.0',
      resolveTsTranspilerVersionFn: () => '5.9.3',
    });

    assert.ok(captured, 'saveMaintainabilityFn must have been invoked');
    for (const k of Object.keys(captured)) {
      assert.ok(
        !k.startsWith('.worktrees/'),
        `key must not carry .worktrees/ prefix; got "${k}"`,
      );
    }
    assert.equal(captured['.agents/scripts/baz.js'], 77);
  });
});

/**
 * commitSnapshotsToEpicBranch — direct unit coverage. The helper drives a
 * fully scripted `spawnSync` sequence (rev-parse → read-tree → hash-object*
 * → update-index* → write-tree → rev-parse parent-tree → commit-tree →
 * update-ref) and reaches the filesystem only via the injected `fsImpl`,
 * so these tests can assert the exact git argv shape produced for each
 * branch without touching a real repo.
 */
function makeGitSpawn(handlers) {
  const calls = [];
  const fn = (cmd, args /* , opts */) => {
    calls.push({ cmd, args: [...args] });
    const handler = handlers(args);
    return {
      status: handler.status ?? 0,
      stdout: handler.stdout ?? '',
      stderr: handler.stderr ?? '',
    };
  };
  fn.calls = calls;
  return fn;
}

function makeFsShimWithFiles(presentPaths) {
  const present = new Set(presentPaths);
  const removed = [];
  return {
    existsSync: (p) => {
      // The temp index file lives in os.tmpdir() with a stable filename prefix.
      // Treat any path under that prefix as present so the helper's finally
      // branch exercises unlinkSync — letting tests assert the cleanup path.
      if (typeof p === 'string' && /baseline-snapshot-\d+-/.test(p)) {
        return true;
      }
      return present.has(p);
    },
    unlinkSync: (p) => removed.push(p),
    _removed: removed,
  };
}

describe('commitSnapshotsToEpicBranch', () => {
  const EPIC_ID = 1179;
  const REPO_CWD = path.resolve('/tmp/repo-1179');
  const FILE_ABS = path.resolve(REPO_CWD, 'temp/epic-1179/baselines/crap.json');

  function happyPathHandlers() {
    return (args) => {
      if (args[0] === 'rev-parse' && args[1] === '--verify') {
        return { status: 0, stdout: 'parent-sha' };
      }
      if (args[0] === 'read-tree') return { status: 0 };
      if (args[0] === 'hash-object') return { status: 0, stdout: 'blob-sha' };
      if (args[0] === 'update-index') return { status: 0 };
      if (args[0] === 'write-tree')
        return { status: 0, stdout: 'new-tree-sha' };
      if (args[0] === 'rev-parse' && /\^\{tree\}$/.test(args[1])) {
        return { status: 0, stdout: 'parent-tree-sha' };
      }
      if (args[0] === 'commit-tree')
        return { status: 0, stdout: 'new-commit-sha' };
      if (args[0] === 'update-ref') return { status: 0 };
      return { status: 1, stderr: `unexpected git ${args.join(' ')}` };
    };
  }

  it('rejects non-positive-integer epicId', () => {
    assert.throws(
      () => commitSnapshotsToEpicBranch({ epicId: 0 }),
      /epicId must be a positive integer/,
    );
    assert.throws(
      () => commitSnapshotsToEpicBranch({ epicId: 'bad' }),
      /epicId must be a positive integer/,
    );
  });

  it('short-circuits with reason=no-files when files: [] is passed', () => {
    const spawnSync = makeGitSpawn(() => ({ status: 0 }));
    const out = commitSnapshotsToEpicBranch({
      epicId: EPIC_ID,
      cwd: REPO_CWD,
      files: [],
      spawnSync,
      fsImpl: makeFsShimWithFiles([]),
      logger: { info: () => {}, warn: () => {} },
    });
    assert.deepEqual(out, { committed: false, reason: 'no-files' });
    assert.equal(spawnSync.calls.length, 0);
  });

  it('short-circuits with reason=no-files when listed files do not exist on disk', () => {
    const spawnSync = makeGitSpawn(() => ({ status: 0 }));
    const out = commitSnapshotsToEpicBranch({
      epicId: EPIC_ID,
      cwd: REPO_CWD,
      files: [{ destination: FILE_ABS }],
      spawnSync,
      fsImpl: makeFsShimWithFiles([]), // FILE_ABS is missing
      logger: { info: () => {}, warn: () => {} },
    });
    assert.deepEqual(out, { committed: false, reason: 'no-files' });
    assert.equal(spawnSync.calls.length, 0);
  });

  it('returns reason=epic-missing when epic branch ref does not exist', () => {
    const spawnSync = makeGitSpawn((args) => {
      if (args[0] === 'rev-parse' && args[1] === '--verify') {
        return { status: 128, stderr: 'unknown revision epic/1179' };
      }
      return { status: 1 };
    });
    const out = commitSnapshotsToEpicBranch({
      epicId: EPIC_ID,
      cwd: REPO_CWD,
      files: [{ destination: FILE_ABS }],
      spawnSync,
      fsImpl: makeFsShimWithFiles([FILE_ABS]),
      logger: { info: () => {}, warn: () => {} },
    });
    assert.equal(out.committed, false);
    assert.equal(out.reason, 'epic-missing');
    assert.match(out.detail, /epic\/1179 does not exist/);
  });

  it('returns reason=epic-missing when read-tree fails', () => {
    const spawnSync = makeGitSpawn((args) => {
      if (args[0] === 'rev-parse' && args[1] === '--verify') {
        return { status: 0, stdout: 'parent-sha' };
      }
      if (args[0] === 'read-tree') {
        return { status: 128, stderr: 'tree corrupt' };
      }
      return { status: 1 };
    });
    const out = commitSnapshotsToEpicBranch({
      epicId: EPIC_ID,
      cwd: REPO_CWD,
      files: [{ destination: FILE_ABS }],
      spawnSync,
      fsImpl: makeFsShimWithFiles([FILE_ABS]),
      logger: { info: () => {}, warn: () => {} },
    });
    assert.equal(out.committed, false);
    assert.equal(out.reason, 'epic-missing');
    assert.match(out.detail, /read-tree failed/);
  });

  it('throws when hash-object fails', () => {
    const spawnSync = makeGitSpawn((args) => {
      if (args[0] === 'rev-parse' && args[1] === '--verify') {
        return { status: 0, stdout: 'parent-sha' };
      }
      if (args[0] === 'read-tree') return { status: 0 };
      if (args[0] === 'hash-object') {
        return { status: 1, stderr: 'cannot hash' };
      }
      return { status: 1 };
    });
    assert.throws(
      () =>
        commitSnapshotsToEpicBranch({
          epicId: EPIC_ID,
          cwd: REPO_CWD,
          files: [{ destination: FILE_ABS }],
          spawnSync,
          fsImpl: makeFsShimWithFiles([FILE_ABS]),
          logger: { info: () => {}, warn: () => {} },
        }),
      /hash-object failed for .*: cannot hash/,
    );
  });

  it('throws when update-index fails', () => {
    const spawnSync = makeGitSpawn((args) => {
      if (args[0] === 'rev-parse' && args[1] === '--verify') {
        return { status: 0, stdout: 'parent-sha' };
      }
      if (args[0] === 'read-tree') return { status: 0 };
      if (args[0] === 'hash-object') return { status: 0, stdout: 'blob-sha' };
      if (args[0] === 'update-index') {
        return { status: 1, stderr: 'index locked' };
      }
      return { status: 1 };
    });
    assert.throws(
      () =>
        commitSnapshotsToEpicBranch({
          epicId: EPIC_ID,
          cwd: REPO_CWD,
          files: [{ destination: FILE_ABS }],
          spawnSync,
          fsImpl: makeFsShimWithFiles([FILE_ABS]),
          logger: { info: () => {}, warn: () => {} },
        }),
      /update-index failed/,
    );
  });

  it('throws when write-tree fails', () => {
    const spawnSync = makeGitSpawn((args) => {
      if (args[0] === 'rev-parse' && args[1] === '--verify') {
        return { status: 0, stdout: 'parent-sha' };
      }
      if (args[0] === 'read-tree') return { status: 0 };
      if (args[0] === 'hash-object') return { status: 0, stdout: 'blob-sha' };
      if (args[0] === 'update-index') return { status: 0 };
      if (args[0] === 'write-tree') {
        return { status: 1, stderr: 'write-tree explode' };
      }
      return { status: 1 };
    });
    assert.throws(
      () =>
        commitSnapshotsToEpicBranch({
          epicId: EPIC_ID,
          cwd: REPO_CWD,
          files: [{ destination: FILE_ABS }],
          spawnSync,
          fsImpl: makeFsShimWithFiles([FILE_ABS]),
          logger: { info: () => {}, warn: () => {} },
        }),
      /write-tree failed/,
    );
  });

  it('returns reason=no-change when staged tree equals parent tree', () => {
    const spawnSync = makeGitSpawn((args) => {
      if (args[0] === 'rev-parse' && args[1] === '--verify') {
        return { status: 0, stdout: 'parent-sha' };
      }
      if (args[0] === 'read-tree') return { status: 0 };
      if (args[0] === 'hash-object') return { status: 0, stdout: 'blob-sha' };
      if (args[0] === 'update-index') return { status: 0 };
      if (args[0] === 'write-tree') {
        return { status: 0, stdout: 'same-tree-sha' };
      }
      if (args[0] === 'rev-parse' && /\^\{tree\}$/.test(args[1])) {
        return { status: 0, stdout: 'same-tree-sha' };
      }
      return { status: 1, stderr: `unexpected ${args.join(' ')}` };
    });
    const out = commitSnapshotsToEpicBranch({
      epicId: EPIC_ID,
      cwd: REPO_CWD,
      files: [{ destination: FILE_ABS }],
      spawnSync,
      fsImpl: makeFsShimWithFiles([FILE_ABS]),
      logger: { info: () => {}, warn: () => {} },
    });
    assert.deepEqual(out, { committed: false, reason: 'no-change' });
    // commit-tree must NOT be invoked when trees match.
    assert.equal(
      spawnSync.calls.some((c) => c.args[0] === 'commit-tree'),
      false,
    );
  });

  it('throws when commit-tree fails', () => {
    const spawnSync = makeGitSpawn((args) => {
      if (args[0] === 'rev-parse' && args[1] === '--verify') {
        return { status: 0, stdout: 'parent-sha' };
      }
      if (args[0] === 'read-tree') return { status: 0 };
      if (args[0] === 'hash-object') return { status: 0, stdout: 'blob-sha' };
      if (args[0] === 'update-index') return { status: 0 };
      if (args[0] === 'write-tree')
        return { status: 0, stdout: 'new-tree-sha' };
      if (args[0] === 'rev-parse' && /\^\{tree\}$/.test(args[1])) {
        return { status: 0, stdout: 'parent-tree-sha' };
      }
      if (args[0] === 'commit-tree') return { status: 1, stderr: 'no author' };
      return { status: 1 };
    });
    assert.throws(
      () =>
        commitSnapshotsToEpicBranch({
          epicId: EPIC_ID,
          cwd: REPO_CWD,
          files: [{ destination: FILE_ABS }],
          spawnSync,
          fsImpl: makeFsShimWithFiles([FILE_ABS]),
          logger: { info: () => {}, warn: () => {} },
        }),
      /commit-tree failed/,
    );
  });

  it('throws when update-ref fails', () => {
    const spawnSync = makeGitSpawn((args) => {
      if (args[0] === 'rev-parse' && args[1] === '--verify') {
        return { status: 0, stdout: 'parent-sha' };
      }
      if (args[0] === 'read-tree') return { status: 0 };
      if (args[0] === 'hash-object') return { status: 0, stdout: 'blob-sha' };
      if (args[0] === 'update-index') return { status: 0 };
      if (args[0] === 'write-tree')
        return { status: 0, stdout: 'new-tree-sha' };
      if (args[0] === 'rev-parse' && /\^\{tree\}$/.test(args[1])) {
        return { status: 0, stdout: 'parent-tree-sha' };
      }
      if (args[0] === 'commit-tree') {
        return { status: 0, stdout: 'new-commit-sha' };
      }
      if (args[0] === 'update-ref') {
        return { status: 1, stderr: 'ref moved' };
      }
      return { status: 1 };
    });
    assert.throws(
      () =>
        commitSnapshotsToEpicBranch({
          epicId: EPIC_ID,
          cwd: REPO_CWD,
          files: [{ destination: FILE_ABS }],
          spawnSync,
          fsImpl: makeFsShimWithFiles([FILE_ABS]),
          logger: { info: () => {}, warn: () => {} },
        }),
      /update-ref failed/,
    );
  });

  it('happy path returns committed sha and emits an info log', () => {
    const spawnSync = makeGitSpawn(happyPathHandlers());
    const logger = silentLogger();
    const fsImpl = makeFsShimWithFiles([FILE_ABS]);
    const out = commitSnapshotsToEpicBranch({
      epicId: EPIC_ID,
      cwd: REPO_CWD,
      files: [{ destination: FILE_ABS }],
      spawnSync,
      fsImpl,
      logger,
    });
    assert.deepEqual(out, { committed: true, sha: 'new-commit-sha' });
    // The argv sequence we expect, in order.
    const cmdSeq = spawnSync.calls.map((c) => c.args[0]);
    assert.deepEqual(cmdSeq, [
      'rev-parse', // verify epic branch
      'read-tree',
      'hash-object',
      'update-index',
      'write-tree',
      'rev-parse', // parent tree
      'commit-tree',
      'update-ref',
    ]);
    // hash-object is invoked with `-w -- <abs-path>`.
    const hashCall = spawnSync.calls.find((c) => c.args[0] === 'hash-object');
    assert.deepEqual(hashCall.args, ['hash-object', '-w', '--', FILE_ABS]);
    // update-index passes the cacheinfo triple with the resolved relative path.
    const updateIdxCall = spawnSync.calls.find(
      (c) => c.args[0] === 'update-index',
    );
    assert.equal(updateIdxCall.args[0], 'update-index');
    assert.equal(updateIdxCall.args[1], '--add');
    assert.equal(updateIdxCall.args[2], '--cacheinfo');
    assert.match(updateIdxCall.args[3], /^100644,blob-sha,/);
    // commit-tree wires the new tree to the parent.
    const commitCall = spawnSync.calls.find((c) => c.args[0] === 'commit-tree');
    assert.deepEqual(commitCall.args.slice(0, 4), [
      'commit-tree',
      'new-tree-sha',
      '-p',
      'parent-sha',
    ]);
    // update-ref points refs/heads/epic/<id> at the new commit, gated on parent.
    const updateRefCall = spawnSync.calls.find(
      (c) => c.args[0] === 'update-ref',
    );
    assert.deepEqual(updateRefCall.args, [
      'update-ref',
      'refs/heads/epic/1179',
      'new-commit-sha',
      'parent-sha',
    ]);
    // info logger fired once with the truncated SHA.
    assert.equal(logger.info.mock.callCount(), 1);
    assert.match(
      logger.info.mock.calls[0].arguments[0],
      /committed 1 snapshot file\(s\) to epic\/1179 \(new-com\)/,
    );
    // Temp index file (resolved during the run) was unlinked in the finally.
    assert.equal(fsImpl._removed.length, 1);
    assert.match(fsImpl._removed[0], /baseline-snapshot-1179-/);
  });
});
