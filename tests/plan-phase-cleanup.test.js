import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  cleanupPhaseTempFiles,
  PHASE_TEMP_PATHS,
  resolvePhaseTempPaths,
} from '../.agents/scripts/lib/plan-phase-cleanup.js';

describe('plan-phase-cleanup.resolvePhaseTempPaths', () => {
  it('returns per-Epic paths under temp/epic-<id>/ for the spec phase', () => {
    const paths = resolvePhaseTempPaths('spec', 441, '/repo');
    assert.equal(paths.length, PHASE_TEMP_PATHS.spec.length);
    assert.ok(paths.every((p) => p.includes('epic-441')));
    assert.ok(paths.some((p) => p.endsWith('prd.md')));
    assert.ok(paths.some((p) => p.endsWith('techspec.md')));
    assert.ok(paths.some((p) => p.endsWith('acceptance-spec.md')));
    assert.ok(paths.some((p) => p.endsWith('planner-context.json')));
  });

  it('returns per-Epic paths under temp/epic-<id>/ for the decompose phase', () => {
    const paths = resolvePhaseTempPaths('decompose', 999_007, '/repo');
    assert.equal(paths.length, PHASE_TEMP_PATHS.decompose.length);
    assert.ok(paths.every((p) => p.includes('epic-999007')));
    assert.ok(paths.some((p) => p.endsWith('tickets.json')));
    assert.ok(paths.some((p) => p.endsWith('decomposer-context.json')));
  });

  it('throws on an unknown phase', () => {
    assert.throws(
      () => resolvePhaseTempPaths('nonsense', 1, '/repo'),
      /Unknown phase/,
    );
  });
});

describe('plan-phase-cleanup.cleanupPhaseTempFiles', () => {
  it('classifies outcomes into deleted / missing / failed', async () => {
    const unlinked = [];
    const fakeUnlink = async (p) => {
      unlinked.push(p);
      if (p.endsWith('prd.md')) return; // success
      if (p.endsWith('acceptance-spec.md')) return; // success
      if (p.endsWith('techspec.md')) {
        const err = new Error('ENOENT');
        err.code = 'ENOENT';
        throw err;
      }
      throw new Error('disk on fire');
    };
    const logger = { warn: () => {} };
    const result = await cleanupPhaseTempFiles({
      phase: 'spec',
      epicId: 1,
      repoRoot: '/repo',
      unlink: fakeUnlink,
      logger,
    });
    assert.equal(result.deleted.length, 2);
    assert.equal(result.missing.length, 1);
    assert.equal(result.failed.length, 1);
    assert.equal(unlinked.length, PHASE_TEMP_PATHS.spec.length);
  });

  it('returns empty buckets when no files match', async () => {
    const result = await cleanupPhaseTempFiles({
      phase: 'decompose',
      epicId: 99,
      repoRoot: '/repo',
      unlink: async () => {
        const err = new Error('ENOENT');
        err.code = 'ENOENT';
        throw err;
      },
    });
    assert.equal(result.deleted.length, 0);
    assert.equal(result.missing.length, PHASE_TEMP_PATHS.decompose.length);
    assert.equal(result.failed.length, 0);
  });
});
