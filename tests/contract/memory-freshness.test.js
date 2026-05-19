/**
 * tests/contract/memory-freshness.test.js — Story #2557 / Task #2571
 *
 * Contract: `epic-plan-spec.js --emit-context` (via `buildAuthoringContext`)
 * MUST attach a `memoryFreshness` key to the planner-context envelope with
 * the canonical `{ scanned, staleEntries, errors }` shape. A fixture entry
 * whose referenced file is deleted MUST be flagged stale, and a subsequent
 * run on the same fixture MUST be a no-op (idempotent).
 *
 * Probe failures (missing memory dir, gh missing) MUST populate
 * `memoryFreshness.errors[]` without aborting Phase 0.
 */

import { strict as assert } from 'node:assert';
import { mkdtempSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { buildAuthoringContext } from '../../.agents/scripts/epic-plan-spec.js';

function makeProvider() {
  return {
    async getEpic(id) {
      return {
        id,
        title: 'Test Epic — memory-freshness contract',
        body: '## Overview\nShort body for contract testing.',
        linkedIssues: { prd: null, techSpec: null },
      };
    },
  };
}

describe('epic-plan-spec --emit-context: memoryFreshness envelope contract', () => {
  let fixtureDir;

  before(async () => {
    fixtureDir = mkdtempSync(path.join(os.tmpdir(), 'memfresh-contract-'));
    // One entry that points at a deleted file (will be flagged).
    await fs.writeFile(
      path.join(fixtureDir, 'dead-fixture.md'),
      '---\ntitle: dead-fixture\n---\nReferences nonexistent-target-xyz.js which is gone.\n',
      'utf8',
    );
    process.env.MANDREL_MEMORY_DIR = fixtureDir;
  });

  after(async () => {
    delete process.env.MANDREL_MEMORY_DIR;
    await fs.rm(fixtureDir, { recursive: true, force: true });
  });

  it('attaches memoryFreshness with the canonical shape and flags a dead fixture reference', async () => {
    const ctx = await buildAuthoringContext(
      1,
      makeProvider(),
      {},
      { github: { owner: 'dsj1984', repo: 'mandrel' } },
    );

    assert.ok(
      Object.hasOwn(ctx, 'memoryFreshness'),
      'planner-context envelope must include memoryFreshness key',
    );
    const mf = ctx.memoryFreshness;
    assert.equal(typeof mf, 'object');
    assert.ok(mf, 'memoryFreshness must not be null');
    assert.equal(typeof mf.scanned, 'number');
    assert.ok(Array.isArray(mf.staleEntries));
    assert.ok(Array.isArray(mf.errors));

    const flagged = mf.staleEntries.find((e) => e.file === 'dead-fixture.md');
    assert.ok(flagged, 'fixture with deleted reference must be flagged stale');
    assert.match(flagged.reason, /nonexistent-target-xyz\.js/);

    // Verify the file on disk now carries stale frontmatter.
    const after = await fs.readFile(
      path.join(fixtureDir, 'dead-fixture.md'),
      'utf8',
    );
    assert.match(after, /stale:\s*true/);
    assert.match(after, /staleReason:/);
    assert.match(after, /staleDetectedAt:/);
  });

  it('is idempotent — a second --emit-context run does not re-flag the already-stale fixture', async () => {
    const ctxFirst = await buildAuthoringContext(
      1,
      makeProvider(),
      {},
      { github: { owner: 'dsj1984', repo: 'mandrel' } },
    );
    const firstFlagged = ctxFirst.memoryFreshness.staleEntries.find(
      (e) => e.file === 'dead-fixture.md',
    );
    // After the prior `it` block, the fixture is already stale on disk, so
    // this first call should already report zero new flags.
    assert.equal(firstFlagged, undefined);

    const fileBefore = await fs.readFile(
      path.join(fixtureDir, 'dead-fixture.md'),
      'utf8',
    );

    const ctxSecond = await buildAuthoringContext(
      1,
      makeProvider(),
      {},
      { github: { owner: 'dsj1984', repo: 'mandrel' } },
    );
    const secondFlagged = ctxSecond.memoryFreshness.staleEntries.find(
      (e) => e.file === 'dead-fixture.md',
    );
    assert.equal(
      secondFlagged,
      undefined,
      'already-stale fixture must not be re-flagged on a second run',
    );

    const fileAfter = await fs.readFile(
      path.join(fixtureDir, 'dead-fixture.md'),
      'utf8',
    );
    assert.equal(
      fileBefore,
      fileAfter,
      'fixture body must be byte-identical across re-runs',
    );
  });

  it('populates memoryFreshness.errors[] without throwing when memory dir is missing', async () => {
    const missing = path.join(
      os.tmpdir(),
      `memfresh-missing-${Date.now()}-${Math.random()}`,
    );
    const prior = process.env.MANDREL_MEMORY_DIR;
    process.env.MANDREL_MEMORY_DIR = missing;
    try {
      const ctx = await buildAuthoringContext(
        1,
        makeProvider(),
        {},
        { github: { owner: 'dsj1984', repo: 'mandrel' } },
      );
      const mf = ctx.memoryFreshness;
      assert.equal(mf.scanned, 0);
      assert.equal(mf.staleEntries.length, 0);
      assert.ok(mf.errors.length >= 1);
      assert.equal(mf.errors[0].phase, 'discover');
    } finally {
      process.env.MANDREL_MEMORY_DIR = prior;
    }
  });
});
