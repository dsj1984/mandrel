/**
 * Envelope discovery + read policy for `/plan --tickets` source ids
 * (Story #4554).
 *
 * These exercise the real filesystem wiring — the part that decides whether a
 * `--tickets` run can silently lose its source set — rather than hand-feeding
 * an envelope object to the resolver.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import {
  loadPlanContextEnvelope,
  PLAN_CONTEXT_FILENAME,
  resolvePlanContextPath,
} from '../../../.agents/scripts/lib/orchestration/plan-persist/plan-context-source.js';
import { resolveSourceTicketIds } from '../../../.agents/scripts/lib/orchestration/plan-persist/supersede-ops.js';

let planDir;

before(async () => {
  planDir = await mkdtemp(path.join(tmpdir(), 'plan-context-source-'));
});

after(async () => {
  await rm(planDir, { recursive: true, force: true });
});

const TICKETS_ENVELOPE = {
  mode: 'tickets',
  sourceTickets: [
    { id: 4525, title: 'Old idea', body: '' },
    { id: 4526, title: 'Other idea', body: '' },
  ],
};

describe('resolvePlanContextPath', () => {
  it('prefers an explicit --plan-context and marks it explicit', () => {
    const resolved = resolvePlanContextPath(
      path.join(planDir, 'custom.json'),
      planDir,
    );
    assert.equal(resolved.path, path.join(planDir, 'custom.json'));
    assert.equal(resolved.explicit, true);
  });

  it('falls back to the conventional file inside --plan-dir', () => {
    const resolved = resolvePlanContextPath(null, planDir);
    assert.equal(resolved.path, path.join(planDir, PLAN_CONTEXT_FILENAME));
    assert.equal(resolved.explicit, false);
  });

  it('returns null when neither is given', () => {
    assert.equal(resolvePlanContextPath(null, null), null);
  });
});

describe('loadPlanContextEnvelope', () => {
  it('reads an envelope written to the conventional --plan-dir path', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'plan-ctx-ok-'));
    const file = path.join(dir, PLAN_CONTEXT_FILENAME);
    await writeFile(file, JSON.stringify(TICKETS_ENVELOPE), 'utf8');

    const envelope = await loadPlanContextEnvelope(
      resolvePlanContextPath(null, dir),
    );
    assert.equal(envelope.mode, 'tickets');
    // The end-to-end point: ids reach the partition with no flag passed.
    assert.deepEqual(resolveSourceTicketIds({ envelope }), {
      ids: [4525, 4526],
      origin: 'envelope',
    });
    await rm(dir, { recursive: true, force: true });
  });

  it('degrades to null (warn) when no path is resolvable at all', async () => {
    assert.equal(await loadPlanContextEnvelope(null), null);
  });

  it('degrades to null when an auto-discovered envelope is simply absent', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'plan-ctx-absent-'));
    assert.equal(
      await loadPlanContextEnvelope(resolvePlanContextPath(null, dir)),
      null,
    );
    await rm(dir, { recursive: true, force: true });
  });

  it('throws when an explicitly named --plan-context is missing', async () => {
    const missing = path.join(planDir, 'nope.json');
    await assert.rejects(
      loadPlanContextEnvelope(resolvePlanContextPath(missing, null)),
      /Cannot read plan-context envelope/,
    );
  });

  // A corrupt envelope must never read as "no source tickets" — that is the
  // vacuous pass this Story closes.
  it('throws on a present-but-unparseable envelope rather than reading it as empty', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'plan-ctx-corrupt-'));
    const file = path.join(dir, PLAN_CONTEXT_FILENAME);
    await writeFile(file, '{ truncated', 'utf8');

    await assert.rejects(
      loadPlanContextEnvelope(resolvePlanContextPath(null, dir)),
      /Failed to parse plan-context envelope/,
    );
    await rm(dir, { recursive: true, force: true });
  });
});
