// tests/lib/orchestration/lifecycle/phase-close-tail.test.js
/**
 * Contract test for `runCodeReview` and `runRetro` emitting their
 * `code-review.start/.end` and `retro.start/.end` event pairs, plus
 * the umbrella `epic.close.end` ordering invariant. Story #2249 / Task
 * #2252.
 *
 * Invariants pinned here:
 *   1. `runCodeReview` emits `code-review.start` then `code-review.end`
 *      in seqId order on a clean run, with severity counts mirrored on
 *      the end payload.
 *   2. `runCodeReview`'s review-finding payload (the `code-review.end`
 *      record persisted by `LedgerWriter`) MUST NOT contain any keys in
 *      the secret-key-denylist (`token`, `password`, `secret`,
 *      `apiKey`, `webhookUrl`). The LedgerWriter strips them
 *      defense-in-depth; this test pins the stripping behavior at the
 *      ledger boundary.
 *   3. `runRetro` emits `retro.start` then `retro.end` in seqId order.
 *   4. `runEpicDeliverCloseTail` emits the umbrella `epic.close.end`
 *      AFTER `retro.end` — the sub-phase pairs all settle before the
 *      umbrella close fires.
 *   5. Critical-findings halts in code-review SKIP `epic.close.end`
 *      (retro never runs; the umbrella waits for the operator to
 *      remediate and resume).
 */

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { runCodeReview } from '../../../../.agents/scripts/lib/orchestration/code-review.js';
import { runEpicDeliverCloseTail } from '../../../../.agents/scripts/lib/orchestration/epic-deliver-close-tail.js';
import { CHECKPOINT_SCHEMA_VERSION } from '../../../fixtures/epic-run-state-store.js';
import { Bus } from '../../../../.agents/scripts/lib/orchestration/lifecycle/bus.js';
import {
  LedgerWriter,
  SECRET_KEY_DENY_LIST,
} from '../../../../.agents/scripts/lib/orchestration/lifecycle/ledger-writer.js';
import { runRetro } from '../../../../.agents/scripts/lib/orchestration/retro-runner.js';

function readNdjson(p) {
  return readFileSync(p, 'utf8')
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l));
}

function quietLogger() {
  return { warn() {}, info() {}, debug() {}, error() {} };
}

function makeCheckpointProvider(initialPhase, epicId = 42) {
  const comments = new Map();
  let nextId = 1;
  if (initialPhase) {
    const marker = `<!-- ap:structured-comment type="epic-run-state" -->`;
    const payload = {
      version: CHECKPOINT_SCHEMA_VERSION,
      epicId,
      phase: initialPhase,
    };
    const body = `${marker}\n\n\`\`\`json\n${JSON.stringify(payload, null, 2)}\n\`\`\``;
    comments.set(epicId, [{ id: nextId++, body }]);
  }
  return {
    async getTicketComments(ticketId) {
      return comments.get(ticketId) ?? [];
    },
    async postComment(ticketId, payload) {
      const id = nextId++;
      const list = comments.get(ticketId) ?? [];
      list.push({ id, body: payload.body });
      comments.set(ticketId, list);
      return { commentId: id };
    },
    async deleteComment(id) {
      for (const [ticketId, list] of comments) {
        const next = list.filter((c) => c.id !== id);
        if (next.length !== list.length) comments.set(ticketId, next);
      }
    },
    async updateTicket() {
      return { ok: true };
    },
    async getTicket(id) {
      return { id, title: `Epic ${id}` };
    },
  };
}

describe('lifecycle/phase-close-tail — code-review.start/.end', () => {
  let tempRoot;

  beforeEach(() => {
    tempRoot = mkdtempSync(path.join(tmpdir(), 'mandrel-code-review-'));
  });
  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('emits code-review.start then code-review.end in seqId order on a clean run', async () => {
    const epicId = 8888;
    const bus = new Bus();
    const writer = new LedgerWriter({ epicId, tempRoot });
    writer.register(bus);

    await runCodeReview({
      epicId,
      bus,
      logger: quietLogger(),
      runner: async () => ({
        status: 'ok',
        severity: { critical: 0, high: 1, medium: 2, suggestion: 3 },
        report: 'review body',
        posted: true,
      }),
    });

    const records = readNdjson(writer.ledgerPath);
    const emitted = records.filter((r) => r.kind === 'emitted');
    assert.equal(emitted.length, 2, 'two emitted records');
    assert.equal(emitted[0].event, 'code-review.start');
    assert.equal(emitted[1].event, 'code-review.end');
    assert.ok(emitted[0].seqId < emitted[1].seqId);
    assert.equal(emitted[1].payload.epicId, epicId);
    assert.equal(emitted[1].payload.status, 'ok');
    assert.deepEqual(emitted[1].payload.severity, {
      critical: 0,
      high: 1,
      medium: 2,
      suggestion: 3,
    });
    assert.equal(emitted[1].payload.halted, false);
    assert.equal(emitted[1].payload.posted, true);
  });

  it('emits code-review.end with halted:true on critical findings', async () => {
    const epicId = 8889;
    const bus = new Bus();
    const writer = new LedgerWriter({ epicId, tempRoot });
    writer.register(bus);

    await runCodeReview({
      epicId,
      bus,
      logger: quietLogger(),
      runner: async () => ({
        status: 'ok',
        severity: { critical: 1, high: 0, medium: 0, suggestion: 0 },
        report: 'review body',
        posted: true,
      }),
    });

    const records = readNdjson(writer.ledgerPath);
    const end = records.find(
      (r) => r.event === 'code-review.end' && r.kind === 'emitted',
    );
    assert.equal(end.payload.halted, true);
    assert.equal(end.payload.severity.critical, 1);
  });

  it('ledger payload omits secret-deny-listed keys even if the runner result accidentally carries them', async () => {
    // The runner's normalized envelope is the source of the ledger
    // payload. Even if a future refactor accidentally surfaces a
    // deny-listed key (e.g. via `report` containing structured data),
    // the LedgerWriter strips it before write — and the
    // `code-review.end` schema's `additionalProperties: false` would
    // reject the emit at the bus.
    //
    // This test verifies the LedgerWriter strip applied to a hand-rolled
    // payload that contains every deny-listed key, asserting the
    // resulting record drops them. The runRetro / runCodeReview
    // pipelines never construct such a payload — `additionalProperties:
    // false` in the schemas prevents it — but the strip is the
    // defense-in-depth surface this AC pins.
    const epicId = 8890;
    const writer = new LedgerWriter({ epicId, tempRoot });
    const raw = {
      epicId,
      status: 'ok',
      severity: {
        critical: 0,
        high: 0,
        medium: 0,
        suggestion: 0,
        // Nested deny-list key — also stripped.
        token: 'should-not-survive',
      },
      token: 'top-level-secret',
      password: 'top-level-password',
      secret: 'top-level-secret-value',
      apiKey: 'top-level-api-key',
      webhookUrl: 'https://hooks.example.com/secret',
    };
    const built = writer.buildEmitted({
      event: 'code-review.end',
      seqId: 1,
      payload: raw,
    });
    assert.equal(typeof built.payload, 'object');
    for (const key of SECRET_KEY_DENY_LIST) {
      assert.equal(
        Object.hasOwn(built.payload, key),
        false,
        `top-level "${key}" must be stripped`,
      );
      assert.equal(
        Object.hasOwn(built.payload.severity, key),
        false,
        `nested "${key}" under severity must be stripped`,
      );
    }
    // Non-secret keys survive untouched.
    assert.equal(built.payload.status, 'ok');
    assert.equal(built.payload.severity.critical, 0);
  });
});

describe('lifecycle/phase-close-tail — retro.start/.end', () => {
  let tempRoot;

  beforeEach(() => {
    tempRoot = mkdtempSync(path.join(tmpdir(), 'mandrel-retro-'));
  });
  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('emits retro.start then retro.end in seqId order with posted:true', async () => {
    const epicId = 9999;
    const bus = new Bus();
    const writer = new LedgerWriter({ epicId, tempRoot });
    writer.register(bus);

    // Stub the provider: getTicket for Epic title, getSubTickets empty.
    const provider = {
      async getTicket() {
        return { id: epicId, title: 'Test Epic' };
      },
      async getSubTickets() {
        return [];
      },
      async postComment() {
        return { commentId: 1 };
      },
      async getTicketComments() {
        return [];
      },
      async deleteComment() {},
    };

    await runRetro({
      epicId,
      provider,
      bus,
      cwd: tempRoot,
      logger: quietLogger(),
      runChecksFn: async () => ({ findings: [] }),
      assembleStateFn: async () => ({}),
      upsertFn: async () => ({ commentId: 42 }),
      // Faked fs to avoid writing to the temp tree.
      fsImpl: {
        mkdirSync() {},
        writeFileSync() {},
      },
    });

    const records = readNdjson(writer.ledgerPath);
    const emitted = records.filter((r) => r.kind === 'emitted');
    assert.equal(emitted.length, 2);
    assert.equal(emitted[0].event, 'retro.start');
    assert.equal(emitted[1].event, 'retro.end');
    assert.ok(emitted[0].seqId < emitted[1].seqId);
    assert.equal(emitted[1].payload.posted, true);
    assert.equal(typeof emitted[1].payload.compact, 'boolean');
    assert.equal(typeof emitted[1].payload.durationMs, 'number');
  });
});

describe('lifecycle/phase-close-tail — umbrella epic.close.end ordering', () => {
  let tempRoot;

  beforeEach(() => {
    tempRoot = mkdtempSync(path.join(tmpdir(), 'mandrel-close-end-'));
  });
  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('emits epic.close.end AFTER retro.end on a clean close-tail run', async () => {
    const epicId = 44;
    const bus = new Bus();
    const writer = new LedgerWriter({ epicId, tempRoot });
    writer.register(bus);
    const provider = makeCheckpointProvider('close-validation', epicId);

    await runEpicDeliverCloseTail({
      epicId,
      provider,
      bus,
      logger: quietLogger(),
      runWaveGateFn: async () => ({ exitCode: 0 }),
      runHierarchyGateFn: async () => ({ exitCode: 0 }),
      // Inject a runCodeReview fake that itself emits code-review.* via
      // the bus so the ledger reflects the production wiring (close-tail
      // passes `bus` into the injected fn — we mirror that here).
      runCodeReviewFn: async ({ bus: innerBus }) => {
        await innerBus?.emit?.('code-review.start', { epicId });
        const result = {
          status: 'ok',
          severity: { critical: 0, high: 0, medium: 0, suggestion: 0 },
          halted: false,
          blockerReason: null,
          posted: true,
        };
        await innerBus?.emit?.('code-review.end', {
          epicId,
          status: 'ok',
          severity: result.severity,
          halted: false,
          posted: true,
        });
        return result;
      },
      runRetroFn: async ({ bus: innerBus }) => {
        await innerBus?.emit?.('retro.start', { epicId });
        const result = {
          posted: true,
          compact: true,
          scorecard: {},
          body: '',
        };
        await innerBus?.emit?.('retro.end', {
          epicId,
          posted: true,
          compact: true,
        });
        return result;
      },
      runFinalizeFn: async () => ({
        epicId,
        ffOk: true,
        pushed: true,
        prUrl: 'https://x/pull/1',
        postedHandoff: true,
      }),
    });

    const records = readNdjson(writer.ledgerPath);
    const emittedSeq = records
      .filter((r) => r.kind === 'emitted')
      .map((r) => r.event);
    // Expected ordering: epic.close.start, code-review.*, retro.*,
    // epic.close.end. (close-validate.* is not emitted here because the
    // close-tail's runWaveGate/runHierarchyGate fakes do not fire them —
    // that ordering is asserted in phase-close-validate.test.js.)
    assert.deepEqual(emittedSeq, [
      'epic.close.start',
      'code-review.start',
      'code-review.end',
      'retro.start',
      'retro.end',
      'epic.close.end',
    ]);

    // The seqId for epic.close.end MUST be strictly greater than the
    // last retro.end seqId — pins the "after retro" ordering AC.
    const retroEnd = records.find(
      (r) => r.event === 'retro.end' && r.kind === 'emitted',
    );
    const epicCloseEnd = records.find(
      (r) => r.event === 'epic.close.end' && r.kind === 'emitted',
    );
    assert.ok(
      epicCloseEnd.seqId > retroEnd.seqId,
      'epic.close.end.seqId > retro.end.seqId',
    );
  });

  it('skips epic.close.end on critical-findings halt (retro never runs)', async () => {
    const epicId = 45;
    const bus = new Bus();
    const writer = new LedgerWriter({ epicId, tempRoot });
    writer.register(bus);
    const provider = makeCheckpointProvider('close-validation', epicId);

    await assert.rejects(
      () =>
        runEpicDeliverCloseTail({
          epicId,
          provider,
          bus,
          logger: quietLogger(),
          runWaveGateFn: async () => ({ exitCode: 0 }),
          runHierarchyGateFn: async () => ({ exitCode: 0 }),
          runCodeReviewFn: async () => ({
            status: 'ok',
            severity: { critical: 1, high: 0, medium: 0, suggestion: 0 },
            halted: true,
            blockerReason: 'code-review reported 1 critical blocker(s)',
            posted: true,
          }),
          runRetroFn: async () => {
            throw new Error('runRetro must not be called on critical halt');
          },
          runFinalizeFn: async () => {
            throw new Error('runFinalize must not be called on critical halt');
          },
        }),
      /Phase D halted/,
    );

    const records = readNdjson(writer.ledgerPath);
    const emittedEvents = records
      .filter((r) => r.kind === 'emitted')
      .map((r) => r.event);
    assert.ok(emittedEvents.includes('epic.close.start'));
    assert.equal(
      emittedEvents.includes('epic.close.end'),
      false,
      'epic.close.end must NOT fire when retro did not run',
    );
    assert.equal(
      emittedEvents.includes('retro.start'),
      false,
      'retro.start must NOT fire when code-review halts',
    );
  });
});
