// tests/deliver-epic-single.test.js
//
// Integration tier (Epic #4475, M4-B — the flip). Three guarantees:
//
//   1. Routing-matrix integration — the `deliver.md` router now dispatches a
//      `single` verdict to the REAL `deliver-epic-single.md` executor (the
//      M4-A fall-through stub is gone), and the kill-switch still forces
//      fan-out.
//   2. No-story-ticket dereference (audit receipt) — the single path's
//      prepare envelope carries `storyCount: 0` and never enumerates child
//      Stories; the executor helper reuses deliver-epic Phases 3–9 (which are
//      Epic-scope).
//   3. Single-path end-to-end (injected deps, no network) — prepare `--single`
//      → slice-map walk (flip each marker) → resume skips `done` slices →
//      per-AC-cluster critic fan-out width = `ceil(totalACs / clusterCeiling)`.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { parseAcIds } from '../.agents/scripts/acceptance-spec-reconciler.js';
import { runEpicDeliverPrepareSingle } from '../.agents/scripts/epic-deliver-prepare.js';
import {
  clusterAcceptanceForConfig,
  expectedClusterCount,
} from '../.agents/scripts/lib/orchestration/acceptance-clusters.js';
import {
  DELIVERY_SINGLE_LABEL,
  resolveEpicDeliveryRoute,
} from '../.agents/scripts/lib/orchestration/deliver-route.js';
import {
  read as readEpicRunState,
  recordSliceStatus,
} from '../.agents/scripts/lib/orchestration/epic-run-state-store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const DELIVER_MD = path.join(REPO_ROOT, '.agents', 'workflows', 'deliver.md');
const SINGLE_HELPER = path.join(
  REPO_ROOT,
  '.agents',
  'workflows',
  'helpers',
  'deliver-epic-single.md',
);

function createFakeProvider({ epic }) {
  let autoId = 1;
  const comments = new Map();
  return {
    _comments: comments,
    async getTicket(id) {
      return id === epic.id ? epic : null;
    },
    async getSubTickets() {
      throw new Error('getSubTickets must not be called under --single');
    },
    async getTicketComments(ticketId) {
      return comments.get(ticketId) ?? [];
    },
    async postComment(ticketId, payload) {
      const list = comments.get(ticketId) ?? [];
      const c = { id: autoId++, body: payload.body };
      list.push(c);
      comments.set(ticketId, list);
      return c;
    },
    async deleteComment(commentId) {
      for (const [, list] of comments) {
        const idx = list.findIndex((c) => c.id === commentId);
        if (idx !== -1) list.splice(idx, 1);
      }
    },
  };
}

const baseConfig = {
  github: { owner: 'test-owner', repo: 'test-repo' },
  project: { baseBranch: 'main' },
};

// An Epic body with BOTH managed sections the single path reads: the Delivery
// Slicing table (the slice walk) and the Acceptance Table (the AC clusters).
function epicBody({ acCount }) {
  const acRows = Array.from(
    { length: acCount },
    (_, i) => `| AC-${i + 1} | criterion ${i + 1} | Pending |`,
  );
  return [
    '## Delivery Slicing',
    '',
    '| Slice | Independent? |',
    '| --- | --- |',
    '| Seed the schema | No |',
    '| Wire the executor | No |',
    '',
    '## Acceptance Table',
    '',
    '| AC | Criterion | Disposition |',
    '| --- | --- | --- |',
    ...acRows,
    '',
  ].join('\n');
}

describe('routing-matrix integration — single reaches the real helper', () => {
  it('a single-marked Epic resolves to the `single` route', () => {
    const r = resolveEpicDeliveryRoute(
      { labels: ['type::epic', DELIVERY_SINGLE_LABEL] },
      null,
      { delivery: { routing: { singleDelivery: true } } },
    );
    assert.equal(r.route, 'single');
  });

  it('the kill-switch still forces fan-out for a single-marked Epic', () => {
    const r = resolveEpicDeliveryRoute(
      { labels: ['type::epic', DELIVERY_SINGLE_LABEL] },
      { decompose: { shape: 'single' } },
      { delivery: { routing: { singleDelivery: false } } },
    );
    assert.equal(r.route, 'fan-out');
  });

  it('deliver.md dispatches `single` to deliver-epic-single.md (stub removed)', () => {
    const md = readFileSync(DELIVER_MD, 'utf8');
    assert.match(
      md,
      /`single`.*deliver-epic-single\.md/s,
      'router must name the real single executor',
    );
    assert.doesNotMatch(
      md,
      /stub \(M4-A\)/,
      'the behavior-preserving M4-A stub language must be gone',
    );
  });

  it('the executor helper exists and reuses deliver-epic Phases 3–9', () => {
    const md = readFileSync(SINGLE_HELPER, 'utf8');
    assert.match(md, /Phases 3–9 reused byte-for-byte|Phases 3–9/);
    assert.match(md, /deliver-epic\.md/);
  });
});

describe('no-story-ticket dereference (audit receipt)', () => {
  it('prepare --single yields storyCount:0 and never enumerates children', async () => {
    const epic = {
      id: 4475,
      labels: ['type::epic', DELIVERY_SINGLE_LABEL],
      body: epicBody({ acCount: 5 }),
    };
    const provider = createFakeProvider({ epic });
    const result = await runEpicDeliverPrepareSingle({
      epicId: 4475,
      injectedProvider: provider,
      injectedConfig: baseConfig,
    });
    // getSubTickets throws in the fake — a clean prepare proves the
    // fan-out enumeration path was never taken.
    assert.equal(result.storyCount, 0);
    assert.equal(result.deliveryShape, 'single');
  });

  it('the executor helper states the no-story-dereference contract', () => {
    const md = readFileSync(SINGLE_HELPER, 'utf8');
    assert.match(
      md,
      /No Story-ticket dereference|dereference no Story ticket/i,
    );
  });
});

describe('single-path end-to-end (injected deps, no network)', () => {
  it('prepare → slice walk → resume-skip → cluster critic width', async () => {
    const acCount = 9;
    const epic = {
      id: 4475,
      labels: ['type::epic', DELIVERY_SINGLE_LABEL],
      body: epicBody({ acCount }),
    };
    const provider = createFakeProvider({ epic });

    // S1 — prepare --single seeds the slice map.
    const prep = await runEpicDeliverPrepareSingle({
      epicId: 4475,
      injectedProvider: provider,
      injectedConfig: baseConfig,
    });
    assert.equal(prep.sliceCount, 2);
    assert.deepEqual(Object.keys(prep.slices), ['slice-1', 'slice-2']);

    // S2 — walk the slices in order, flipping each marker as it commits.
    await recordSliceStatus({
      provider,
      epicId: 4475,
      sliceId: 'slice-1',
      status: 'done',
    });

    // Crash-resume: re-prepare preserves the done slice; the walk skips it.
    const resumed = await runEpicDeliverPrepareSingle({
      epicId: 4475,
      injectedProvider: provider,
      injectedConfig: baseConfig,
    });
    assert.equal(resumed.slices['slice-1'].status, 'done');
    assert.equal(resumed.slices['slice-2'].status, 'pending');

    // Finish the walk.
    await recordSliceStatus({
      provider,
      epicId: 4475,
      sliceId: 'slice-2',
      status: 'done',
    });
    const finalState = await readEpicRunState({ provider, epicId: 4475 });
    assert.ok(
      Object.values(finalState.slices).every((s) => s.status === 'done'),
      'every slice done before the acceptance gate',
    );

    // S2a — cluster the Epic's ACs; the critic fan-out width is
    // ceil(totalACs / clusterCeiling) — the acceptance-dilution guard.
    const acIds = parseAcIds(epic.body);
    assert.equal(acIds.length, acCount);
    const { clusters, clusterCeiling } = clusterAcceptanceForConfig(
      acIds,
      baseConfig,
    );
    assert.equal(clusterCeiling, 4); // default
    assert.equal(clusters.length, expectedClusterCount(acCount, 4));
    assert.equal(clusters.length, 3); // ceil(9/4) — three independent critics
    // Every AC is covered by exactly one cluster (no AC dropped).
    assert.deepEqual(
      clusters.flatMap((c) => c.acIds).sort(),
      acIds.slice().sort(),
    );
  });
});
