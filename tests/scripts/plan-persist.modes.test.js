/**
 * tests/scripts/plan-persist.modes.test.js — Epic #4474 PR4.
 *
 * Mode-matrix coverage for the delivery-shape modes of the collapsed
 * persist surface (design §2):
 *
 *   - risk-verdict schema: the new optional `deliveryShape` /
 *     `deliveryShapeRationale` fields validate; existing verdicts stay
 *     valid; bad enums and a shape without rationale fail closed;
 *   - table-driven mode coherence (`resolveDeliveryMode`): full /
 *     spec-only / amend × valid and incoherent inputs — including the
 *     DAG-skip fence (single + tickets is a hard error, so the
 *     validator/DAG skip branch is unreachable when tickets are present);
 *   - single-delivery persist variant: `delivery::single` marker, NO story
 *     tree, `decompose = { ticketCount: 0, shape: "single" }` checkpoint,
 *     summary routing record `{ deliveryShape, sliceCount,
 *     routingReasons }`, section gate + healthcheck still enforced;
 *   - fan-out `--force` over a former single plan drops the stale marker;
 *   - `--amend` delta path: op partition validation, merged-set DAG
 *     (cycle spanning add → keep → modify; dependency on a closed slug),
 *     close-op confirmation gate (exit-2-style error with the dry-run
 *     diff, zero mutations), op-mapped apply (close, close-and-recreate,
 *     create, keep untouched by construction), state-ledger rebuild.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { upsertEpicSection } from '../../.agents/scripts/lib/epic-body-sections.js';
import {
  AGENT_LABELS,
  DELIVERY_LABELS,
} from '../../.agents/scripts/lib/label-constants.js';
import { validateRiskVerdict } from '../../.agents/scripts/lib/orchestration/epic-plan-spec/phases/risk-verdict.js';
import { read as readPlanState } from '../../.agents/scripts/lib/orchestration/epic-plan-state-store.js';
import {
  AmendExplicitCloseError,
  buildMergedTicketSet,
  partitionAmendTickets,
} from '../../.agents/scripts/lib/orchestration/plan-persist/amend.js';
import {
  countDeliverySlices,
  resolveDeliveryMode,
} from '../../.agents/scripts/lib/orchestration/plan-persist/delivery-mode.js';
import { runPlanPersist } from '../../.agents/scripts/lib/orchestration/plan-persist/run-plan-persist.js';
import { PLAN_SUMMARY_COMMENT_TYPE } from '../../.agents/scripts/lib/orchestration/plan-persist/summary.js';
import { structuredCommentMarker } from '../../.agents/scripts/lib/orchestration/ticketing.js';
import { writeSpec } from '../../.agents/scripts/lib/spec/index.js';
import { serialize } from '../../.agents/scripts/lib/story-body/story-body.js';

const EPIC_ID = 8877;
const OPERATOR = 'plan-persist-modes-tester';
const CONFIG = { github: { operatorHandle: OPERATOR } };

const TECH_SPEC = [
  '## Delivery Slicing',
  '',
  '| Slice | What ships | Independent? |',
  '| --- | --- | --- |',
  '| S1 | the schema | No |',
  '| S2 | the modes | No |',
].join('\n');

const FAN_OUT_VERDICT = {
  axes: [
    {
      axis: 'internal-refactor',
      level: 'low',
      rationale: 'Test fixture — internal tooling only.',
    },
  ],
  summary: 'Low-risk internal refactor (test fixture).',
};

const SINGLE_VERDICT = {
  ...FAN_OUT_VERDICT,
  deliveryShape: 'single',
  deliveryShapeRationale:
    'Delivery Slicing is a pure 2-slice dependent chain — one-pass-sized.',
};

/** Build a minimal valid Story ticket. */
function ticket(slug, { dependsOn = [], op, id, title } = {}) {
  const t = {
    slug,
    type: 'story',
    title: title ?? `Story ${slug}`,
    body: serialize({
      goal: `Goal of ${slug}.`,
      changes: [
        {
          path: 'tests/scripts/epic-plan.spec-flow.test.js',
          assumption: 'refactors-existing',
        },
      ],
      acceptance: [`${slug} done`],
      verify: ['npm test (validate)'],
    }),
    labels: ['type::story'],
    depends_on: dependsOn,
    acceptance: [`${slug} done`],
    verify: ['npm test (validate)'],
  };
  if (op !== undefined) t.op = op;
  if (id !== undefined) t.id = id;
  return t;
}

/** In-memory provider stub (same surface the PR3 integration stub covers). */
function buildStubProvider({
  epicLabels = ['type::epic'],
  children = [],
} = {}) {
  let nextId = 9500;
  let nextCommentId = 1000;
  const issues = new Map();
  const comments = new Map();
  const labelHistory = [];
  issues.set(EPIC_ID, {
    id: EPIC_ID,
    title: 'Modes Test Epic',
    body: upsertEpicSection(
      '## Context\nModes fixture.\n',
      'techSpec',
      TECH_SPEC,
    ),
    labels: [...epicLabels],
    assignees: [],
    state: 'open',
  });
  for (const child of children) {
    issues.set(child.id, {
      parentId: EPIC_ID,
      labels: ['type::story'],
      assignees: [],
      state: 'open',
      body: '',
      ...child,
    });
  }
  return {
    issues,
    comments,
    labelHistory,
    createTicketCalls: 0,
    async getEpic(id) {
      return issues.get(id);
    },
    async getTicket(id) {
      return issues.get(id);
    },
    async getTickets() {
      return Array.from(issues.values()).filter((t) => t.id !== EPIC_ID);
    },
    async getSubTickets(parentId) {
      return Array.from(issues.values()).filter(
        (t) => t.parentId === parentId && t.state === 'open',
      );
    },
    async createTicket(parentId, payload) {
      this.createTicketCalls += 1;
      const id = nextId++;
      issues.set(id, {
        id,
        parentId,
        title: payload.title,
        body: payload.body ?? '',
        labels: payload.labels ?? [],
        assignees: [],
        state: 'open',
      });
      return { id, url: `https://stub/issues/${id}` };
    },
    async updateTicket(id, patch) {
      const cur = issues.get(id) ?? { id, labels: [], assignees: [] };
      if (patch.title) cur.title = patch.title;
      if (patch.body !== undefined) cur.body = patch.body;
      if (Array.isArray(patch.assignees)) cur.assignees = [...patch.assignees];
      if (Array.isArray(patch.labels)) cur.labels = [...patch.labels];
      if (
        patch.labels &&
        typeof patch.labels === 'object' &&
        !Array.isArray(patch.labels)
      ) {
        const existing = new Set(cur.labels ?? []);
        for (const add of patch.labels.add ?? []) {
          existing.add(add);
          labelHistory.push({ id, op: 'add', label: add });
        }
        for (const rm of patch.labels.remove ?? []) {
          existing.delete(rm);
          labelHistory.push({ id, op: 'remove', label: rm });
        }
        cur.labels = Array.from(existing);
      }
      if (patch.state) cur.state = patch.state;
      issues.set(id, cur);
      return cur;
    },
    async getTicketComments(id) {
      return comments.get(id) ?? [];
    },
    async createComment(id, body) {
      const cid = nextCommentId++;
      const arr = comments.get(id) ?? [];
      arr.push({ id: cid, body });
      comments.set(id, arr);
      return { id: cid, body };
    },
    async postComment(id, payload) {
      const body = typeof payload === 'string' ? payload : payload.body;
      return this.createComment(id, body);
    },
    async updateComment(_issueId, commentId, body) {
      for (const arr of comments.values()) {
        for (const c of arr) {
          if (c.id === commentId) {
            c.body = body;
            return c;
          }
        }
      }
      return null;
    },
    async deleteComment() {
      return false;
    },
    async addSubIssue() {
      return { ok: true };
    },
    async removeSubIssue() {
      return { ok: true };
    },
    primeTicketCache() {},
  };
}

function commentsOfType(provider, epicId, type) {
  const marker = structuredCommentMarker(type);
  return (provider.comments.get(epicId) ?? []).filter((c) =>
    c.body.startsWith(marker),
  );
}

let sandbox;
let epicsDir;

beforeEach(() => {
  sandbox = mkdtempSync(path.join(os.tmpdir(), 'plan-persist-modes-'));
  epicsDir = path.join(sandbox, '.agents', 'epics');
});

afterEach(() => {
  if (sandbox) rmSync(sandbox, { recursive: true, force: true });
});

function baseOpts(overrides = {}) {
  return {
    skipHealthcheck: true,
    skipCleanup: true,
    spawnSync: () => ({ status: 0, stdout: '', stderr: '' }),
    writeSpecFn: (epicId, spec) => writeSpec(epicId, spec, { epicsDir }),
    loadStateFn: () => ({ epicId: EPIC_ID, mapping: {} }),
    writeStateFn: () => '/dev/null',
    bddProbeFn: async () => null,
    ...overrides,
  };
}

function baseInput(provider, { artifacts = {}, opts = {} } = {}) {
  return {
    epicId: EPIC_ID,
    provider,
    artifacts: {
      techSpecContent: TECH_SPEC,
      acceptanceSpecContent: null,
      riskVerdict: FAN_OUT_VERDICT,
      tickets: null,
      ...artifacts,
    },
    config: CONFIG,
    settings: {
      baseBranch: 'main',
      paths: { tempRoot: path.join(sandbox, 'temp') },
    },
    opts: baseOpts(opts),
  };
}

describe('risk-verdict schema — deliveryShape field (PR4)', () => {
  it('accepts a verdict without deliveryShape (existing verdicts stay valid)', () => {
    assert.equal(validateRiskVerdict(FAN_OUT_VERDICT), FAN_OUT_VERDICT);
  });

  it('accepts deliveryShape "single" and "fan-out" with a rationale', () => {
    assert.ok(validateRiskVerdict(SINGLE_VERDICT));
    assert.ok(
      validateRiskVerdict({
        ...FAN_OUT_VERDICT,
        deliveryShape: 'fan-out',
        deliveryShapeRationale: '4 independent slices.',
      }),
    );
  });

  it('rejects an unknown deliveryShape enum value', () => {
    assert.throws(
      () =>
        validateRiskVerdict({
          ...FAN_OUT_VERDICT,
          deliveryShape: 'mob',
          deliveryShapeRationale: 'x',
        }),
      /schema validation/,
    );
  });

  it('rejects deliveryShape without deliveryShapeRationale (dependentRequired)', () => {
    assert.throws(
      () =>
        validateRiskVerdict({ ...FAN_OUT_VERDICT, deliveryShape: 'single' }),
      /schema validation/,
    );
  });
});

describe('resolveDeliveryMode — table-driven mode matrix (design §2)', () => {
  const tickets = () => [ticket('story-a')];
  const amendTickets = () => [ticket('story-a', { op: 'add' })];

  const rows = [
    {
      name: 'full fan-out (shape absent) with tickets',
      verdict: FAN_OUT_VERDICT,
      tickets: tickets(),
      amend: false,
      expect: 'fan-out',
    },
    {
      name: 'explicit fan-out with tickets',
      verdict: { ...FAN_OUT_VERDICT, deliveryShape: 'fan-out' },
      tickets: tickets(),
      amend: false,
      expect: 'fan-out',
    },
    {
      name: 'spec-only single with no tickets',
      verdict: SINGLE_VERDICT,
      tickets: null,
      amend: false,
      expect: 'single',
    },
    {
      name: 'single with an empty tickets array is still single (no payload)',
      verdict: SINGLE_VERDICT,
      tickets: [],
      amend: false,
      expect: 'single',
    },
    {
      name: 'single WITH tickets — DAG-skip fence (incoherent)',
      verdict: SINGLE_VERDICT,
      tickets: tickets(),
      amend: false,
      expect: /mode-coherence/,
    },
    {
      name: 'fan-out without tickets (incoherent)',
      verdict: FAN_OUT_VERDICT,
      tickets: null,
      amend: false,
      expect: /non-empty tickets array/,
    },
    {
      name: 'unknown shape (incoherent)',
      verdict: { ...FAN_OUT_VERDICT, deliveryShape: 'mob' },
      tickets: tickets(),
      amend: false,
      expect: /unknown deliveryShape/,
    },
    {
      name: 'amend with op-carrying tickets',
      verdict: FAN_OUT_VERDICT,
      tickets: amendTickets(),
      amend: true,
      expect: 'amend',
    },
    {
      name: 'amend + single shape (incoherent)',
      verdict: SINGLE_VERDICT,
      tickets: amendTickets(),
      amend: true,
      expect: /incoherent with deliveryShape "single"/,
    },
    {
      name: 'amend without tickets (incoherent)',
      verdict: FAN_OUT_VERDICT,
      tickets: null,
      amend: true,
      expect: /--amend requires a tickets payload/,
    },
    {
      name: 'op fields without --amend (incoherent)',
      verdict: FAN_OUT_VERDICT,
      tickets: amendTickets(),
      amend: false,
      expect: /--amend was not passed/,
    },
  ];

  for (const row of rows) {
    it(row.name, () => {
      if (typeof row.expect === 'string') {
        assert.equal(
          resolveDeliveryMode(row.verdict, row.tickets, { amend: row.amend }),
          row.expect,
        );
      } else {
        assert.throws(
          () =>
            resolveDeliveryMode(row.verdict, row.tickets, {
              amend: row.amend,
            }),
          row.expect,
        );
      }
    });
  }
});

describe('plan-persist — single-delivery variant (spec-only)', () => {
  it('applies delivery::single, creates NO story tree, checkpoints {ticketCount: 0, shape: "single"}, and records the routing record', async () => {
    const provider = buildStubProvider();
    const spawnCalls = [];
    const result = await runPlanPersist(
      baseInput(provider, {
        artifacts: { riskVerdict: SINGLE_VERDICT, tickets: null },
        opts: {
          spawnSync: (...args) => {
            spawnCalls.push(args);
            return { status: 0, stdout: '', stderr: '' };
          },
        },
      }),
    );

    const epic = provider.issues.get(EPIC_ID);
    // Marker + terminal ready flip; no story tree, no reconciler spawn.
    assert.ok(epic.labels.includes(DELIVERY_LABELS.SINGLE));
    assert.ok(epic.labels.includes(AGENT_LABELS.READY));
    assert.equal(provider.createTicketCalls, 0, 'no story tree in single mode');
    assert.equal(spawnCalls.length, 0, 'reconciler never spawned');

    // Managed sections + risk comment still persisted (single mode skips
    // ONLY the ticket validator/DAG and the story tree).
    assert.match(epic.body, /## Delivery Slicing/);
    assert.equal(commentsOfType(provider, EPIC_ID, 'risk-verdict').length, 1);

    // Checkpoint: deliberate zero-ticket single-shape decompose block.
    const state = await readPlanState({ provider, epicId: EPIC_ID });
    assert.equal(state.decompose.ticketCount, 0);
    assert.equal(state.decompose.shape, 'single');
    assert.ok(state.decompose.completedAt);
    assert.equal(state.persist.mode, 'single');
    assert.ok(state.persist.completedAt);

    // Summary carries the routing record with sliceCount from the
    // Delivery Slicing table and the verdict rationale as routingReasons.
    const summaries = commentsOfType(
      provider,
      EPIC_ID,
      PLAN_SUMMARY_COMMENT_TYPE,
    );
    assert.equal(summaries.length, 1);
    assert.match(summaries[0].body, /"deliveryShape": "single"/);
    assert.match(summaries[0].body, /"sliceCount": 2/);
    assert.match(summaries[0].body, /pure 2-slice dependent chain/);
    assert.match(summaries[0].body, /inert until #4475/);

    // Result envelope.
    assert.equal(result.mode, 'single');
    assert.equal(result.ticketCount, 0);
    assert.deepEqual(result.waveTable, []);
    assert.equal(result.single.sliceCount, 2);
    assert.deepEqual(
      provider.issues.get(EPIC_ID).assignees,
      [],
      'lease released',
    );
  });

  it('still enforces the section gate with ZERO provider calls', async () => {
    const inner = buildStubProvider();
    let providerCalls = 0;
    const counting = new Proxy(inner, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (typeof value === 'function') {
          return (...args) => {
            providerCalls += 1;
            return value.apply(target, args);
          };
        }
        return value;
      },
    });
    await assert.rejects(
      runPlanPersist(
        baseInput(counting, {
          artifacts: {
            techSpecContent: '## Not A Spec\n\nNo slicing here.',
            riskVerdict: SINGLE_VERDICT,
            tickets: null,
          },
        }),
      ),
      /Delivery Slicing/,
    );
    assert.equal(providerCalls, 0);
  });

  it('still runs the healthcheck gate (a failure refuses the ready flip)', async () => {
    const provider = buildStubProvider();
    await assert.rejects(
      runPlanPersist(
        baseInput(provider, {
          artifacts: { riskVerdict: SINGLE_VERDICT, tickets: null },
          opts: {
            skipHealthcheck: false,
            runHealthcheckFn: async () => ({
              ok: false,
              reason: 'git remote unreachable',
            }),
          },
        }),
      ),
      /Refusing agent::ready handoff/,
    );
    const epic = provider.issues.get(EPIC_ID);
    assert.ok(!epic.labels.includes(AGENT_LABELS.READY));
    assert.deepEqual(epic.assignees, [], 'lease released on gate failure');
  });

  it('a fan-out --force re-persist over a former single plan drops the stale marker', async () => {
    const provider = buildStubProvider({
      epicLabels: ['type::epic', DELIVERY_LABELS.SINGLE],
    });
    await runPlanPersist(
      baseInput(provider, {
        artifacts: {
          riskVerdict: FAN_OUT_VERDICT,
          tickets: [
            ticket('story-a'),
            ticket('story-b', { dependsOn: ['story-a'] }),
          ],
        },
        opts: { force: true },
      }),
    );
    const epic = provider.issues.get(EPIC_ID);
    assert.ok(!epic.labels.includes(DELIVERY_LABELS.SINGLE));
    assert.ok(epic.labels.includes(AGENT_LABELS.READY));
  });

  it('countDeliverySlices fails open to null without a slicing table', () => {
    assert.equal(countDeliverySlices('## Something Else\n\ntext'), null);
    assert.equal(countDeliverySlices(TECH_SPEC), 2);
  });
});

describe('plan-persist — amend op partition and merged set', () => {
  it('partitions valid ops and rejects unknown/missing ops and duplicate slugs', () => {
    const partition = partitionAmendTickets([
      ticket('a', { op: 'add' }),
      ticket('b', { op: 'modify' }),
      ticket('c', { op: 'keep' }),
      ticket('d', { op: 'close' }),
    ]);
    assert.deepEqual(
      [
        partition.add.length,
        partition.modify.length,
        partition.keep.length,
        partition.close.length,
      ],
      [1, 1, 1, 1],
    );
    assert.throws(
      () => partitionAmendTickets([ticket('a', { op: 'replace' })]),
      /invalid op/,
    );
    assert.throws(() => partitionAmendTickets([ticket('a')]), /invalid op/);
    assert.throws(
      () =>
        partitionAmendTickets([
          ticket('a', { op: 'add' }),
          ticket('a', { op: 'keep' }),
        ]),
      /duplicate slug/,
    );
  });

  it('buildMergedTicketSet excludes closes and strips op/id carrier fields', () => {
    const merged = buildMergedTicketSet([
      ticket('a', { op: 'add' }),
      ticket('b', { op: 'keep', id: 9001 }),
      ticket('c', { op: 'close', id: 9002 }),
    ]);
    assert.deepEqual(
      merged.map((t) => t.slug),
      ['a', 'b'],
    );
    for (const t of merged) {
      assert.ok(!('op' in t), 'op stripped');
      assert.ok(!('id' in t), 'id stripped');
    }
  });
});

describe('plan-persist — amend delta path (integration)', () => {
  const KEEP_ID = 9001;
  const MOD_ID = 9002;
  const CLOSE_ID = 9003;

  function amendChildren() {
    return [
      { id: KEEP_ID, title: 'Story story-keep', body: 'keep body' },
      { id: MOD_ID, title: 'Story story-mod', body: 'old mod body' },
      { id: CLOSE_ID, title: 'Story story-close', body: 'close body' },
    ];
  }

  function ledger() {
    return {
      epicId: EPIC_ID,
      mapping: {
        'story-keep': { entity: 'story', issueNumber: KEEP_ID },
        'story-mod': { entity: 'story', issueNumber: MOD_ID },
        'story-close': { entity: 'story', issueNumber: CLOSE_ID },
      },
    };
  }

  function amendPayload() {
    return [
      ticket('story-keep', { op: 'keep' }),
      ticket('story-mod', { op: 'modify', dependsOn: ['story-keep'] }),
      ticket('story-new', { op: 'add', dependsOn: ['story-mod'] }),
      ticket('story-close', { op: 'close' }),
    ];
  }

  it('refuses close ops without --explicit-delete: exit-2-style error, dry-run diff, ZERO mutations', async () => {
    const provider = buildStubProvider({ children: amendChildren() });
    let caught;
    try {
      await runPlanPersist(
        baseInput(provider, {
          artifacts: { tickets: amendPayload() },
          opts: { amend: true, loadStateFn: () => ledger() },
        }),
      );
      assert.fail('expected AmendExplicitCloseError');
    } catch (err) {
      caught = err;
    }
    assert.ok(caught instanceof AmendExplicitCloseError);
    assert.equal(caught.code, 'PLAN_AMEND_EXPLICIT_DELETE_REQUIRED');
    assert.match(
      caught.diff,
      /\| close \| `story-close` \| #9003 \| closed \|/,
    );
    assert.match(
      caught.diff,
      /\| modify \| `story-mod` \| #9002 \| closed \+ recreated \|/,
    );
    assert.match(caught.diff, /\| add \| `story-new` \| — \| created \|/);
    assert.match(
      caught.diff,
      /\| keep \| `story-keep` \| #9001 \| untouched \|/,
    );

    // Nothing mutated: all three children still open, no new issues.
    assert.equal(provider.issues.get(CLOSE_ID).state, 'open');
    assert.equal(provider.issues.get(MOD_ID).state, 'open');
    assert.equal(provider.createTicketCalls, 0);
  });

  it('applies the op map with --explicit-delete: close, close-and-recreate, create, keep untouched', async () => {
    const provider = buildStubProvider({ children: amendChildren() });
    const stateWrites = [];
    const spawnCalls = [];
    const result = await runPlanPersist(
      baseInput(provider, {
        artifacts: { tickets: amendPayload() },
        opts: {
          amend: true,
          explicitDelete: true,
          loadStateFn: () => ledger(),
          writeStateFn: (epicId, state) => {
            stateWrites.push({ epicId, state });
            return '/dev/null';
          },
          spawnSync: (...args) => {
            spawnCalls.push(args);
            return { status: 0, stdout: '', stderr: '' };
          },
        },
      }),
    );

    // close op: closed. modify op: closed + recreated. keep: byte-untouched.
    assert.equal(provider.issues.get(CLOSE_ID).state, 'closed');
    assert.equal(provider.issues.get(MOD_ID).state, 'closed');
    const keep = provider.issues.get(KEEP_ID);
    assert.equal(keep.state, 'open');
    assert.equal(keep.body, 'keep body', 'keep is never touched');
    // Two creations: the modify recreate + the add.
    assert.equal(provider.createTicketCalls, 2);
    assert.equal(spawnCalls.length, 0, 'amend never spawns the reconciler');

    // Result envelope + summary.
    assert.equal(result.mode, 'amend');
    assert.equal(result.ticketCount, 3, 'merged set: keep + modify + add');
    assert.equal(result.amend.closed.length, 1);
    assert.equal(result.amend.recreated.length, 1);
    assert.equal(result.amend.created.length, 1);
    assert.equal(result.amend.keptCount, 1);
    const summaries = commentsOfType(
      provider,
      EPIC_ID,
      PLAN_SUMMARY_COMMENT_TYPE,
    );
    assert.equal(summaries.length, 1);
    assert.match(
      summaries[0].body,
      /Amend delta: 1 added, 1 modified \(closed \+ recreated\), 1 closed, 1 kept untouched\./,
    );

    // Merged-set checkpoint (fan-out shape) + terminal persist mode.
    const state = await readPlanState({ provider, epicId: EPIC_ID });
    assert.equal(state.decompose.ticketCount, 3);
    assert.equal(state.decompose.shape, 'fan-out');
    assert.equal(state.persist.mode, 'amend');
    assert.ok(state.persist.completedAt);

    // State ledger rebuilt over the merged set: closed slugs dropped,
    // recreated/created slugs mapped to fresh issue numbers, keep intact.
    const written = stateWrites.at(-1).state;
    assert.ok(!('story-close' in written.mapping));
    assert.equal(written.mapping['story-keep'].issueNumber, KEEP_ID);
    assert.notEqual(written.mapping['story-mod'].issueNumber, MOD_ID);
    assert.ok(Number.isInteger(written.mapping['story-new'].issueNumber));

    // Terminal flip + lease release.
    const epic = provider.issues.get(EPIC_ID);
    assert.ok(epic.labels.includes(AGENT_LABELS.READY));
    assert.deepEqual(epic.assignees, []);
  });

  it('an amend without live close ops proceeds without --explicit-delete', async () => {
    const provider = buildStubProvider({
      children: [{ id: KEEP_ID, title: 'Story story-keep', body: 'keep body' }],
    });
    const result = await runPlanPersist(
      baseInput(provider, {
        artifacts: {
          tickets: [
            ticket('story-keep', { op: 'keep' }),
            ticket('story-new', { op: 'add', dependsOn: ['story-keep'] }),
          ],
        },
        opts: {
          amend: true,
          loadStateFn: () => ({
            epicId: EPIC_ID,
            mapping: {
              'story-keep': { entity: 'story', issueNumber: KEEP_ID },
            },
          }),
        },
      }),
    );
    assert.equal(result.mode, 'amend');
    assert.equal(result.amend.created.length, 1);
    assert.equal(provider.issues.get(KEEP_ID).state, 'open');
  });

  it('validates the DAG over the MERGED set: a cycle spanning add → keep → modify is rejected before any provider call', async () => {
    const inner = buildStubProvider({ children: amendChildren() });
    let providerCalls = 0;
    const counting = new Proxy(inner, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (typeof value === 'function') {
          return (...args) => {
            providerCalls += 1;
            return value.apply(target, args);
          };
        }
        return value;
      },
    });
    await assert.rejects(
      runPlanPersist(
        baseInput(counting, {
          artifacts: {
            tickets: [
              ticket('story-keep', { op: 'keep', dependsOn: ['story-mod'] }),
              ticket('story-mod', { op: 'modify', dependsOn: ['story-new'] }),
              ticket('story-new', { op: 'add', dependsOn: ['story-keep'] }),
            ],
          },
          opts: {
            amend: true,
            explicitDelete: true,
            loadStateFn: () => ledger(),
          },
        }),
      ),
      /Circular dependency/,
    );
    assert.equal(providerCalls, 0, 'merged-set DAG rejects pre-provider');
  });

  it('rejects a dependency pointing at a closed slug (unknown in the merged set)', async () => {
    const provider = buildStubProvider({ children: amendChildren() });
    await assert.rejects(
      runPlanPersist(
        baseInput(provider, {
          artifacts: {
            tickets: [
              ticket('story-keep', { op: 'keep', dependsOn: ['story-close'] }),
              ticket('story-close', { op: 'close' }),
            ],
          },
          opts: {
            amend: true,
            explicitDelete: true,
            loadStateFn: () => ledger(),
          },
        }),
      ),
      /unknown slugs/,
    );
  });

  it('hard-errors when a modify slug resolves to no existing issue (never guesses)', async () => {
    const provider = buildStubProvider({ children: amendChildren() });
    await assert.rejects(
      runPlanPersist(
        baseInput(provider, {
          artifacts: {
            tickets: [ticket('story-ghost', { op: 'modify' })],
          },
          opts: {
            amend: true,
            explicitDelete: true,
            loadStateFn: () => ledger(),
          },
        }),
      ),
      /resolves to no existing issue/,
    );
  });

  it('hard-errors when an add slug collides with an existing mapped issue', async () => {
    const provider = buildStubProvider({ children: amendChildren() });
    await assert.rejects(
      runPlanPersist(
        baseInput(provider, {
          artifacts: {
            tickets: [ticket('story-keep', { op: 'add' })],
          },
          opts: {
            amend: true,
            explicitDelete: true,
            loadStateFn: () => ledger(),
          },
        }),
      ),
      /collides with existing issue #9001/,
    );
  });

  it('resolves an explicit ticket `id` ahead of the state ledger', async () => {
    // Empty ledger; the ticket carries the issue number itself (the
    // authoring envelope's open-children listing is the source).
    const provider = buildStubProvider({ children: amendChildren() });
    const result = await runPlanPersist(
      baseInput(provider, {
        artifacts: {
          tickets: [ticket('story-keep', { op: 'keep', id: KEEP_ID })],
        },
        opts: {
          amend: true,
          loadStateFn: () => ({ epicId: EPIC_ID, mapping: {} }),
        },
      }),
    );
    assert.equal(result.amend.keptCount, 1);
  });

  it('rejects --amend combined with --force or --resume, and with ideation mode', async () => {
    const provider = buildStubProvider({ children: amendChildren() });
    await assert.rejects(
      runPlanPersist(
        baseInput(provider, {
          artifacts: { tickets: amendPayload() },
          opts: { amend: true, force: true },
        }),
      ),
      /mutually exclusive/,
    );
    await assert.rejects(
      runPlanPersist({
        ...baseInput(provider, {
          artifacts: {
            tickets: amendPayload(),
            onePagerContent: '# Idea\n\n## Context\nx\n',
            templateContent: '# {{title}}\n\n## Context\n{{context}}\n',
          },
          opts: { amend: true },
        }),
        epicId: null,
      }),
      /--amend requires --epic/,
    );
  });
});
