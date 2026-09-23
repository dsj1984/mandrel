/**
 * Property / model-based tests for the container-Epic rollup (Story #5424).
 *
 * The hand-picked cases in `epic-rollup.test.js` pin known shapes; these
 * properties drive the public entry point, `rollUpEpicForStory`, through a
 * fake GitHub whose reads can fail or lie, over generated command sequences
 * and generated interleavings, and check the invariants from the header of
 * `.agents/scripts/lib/orchestration/epic-rollup.js`:
 *
 *   - never throws; never writes an `agent::*` label to the Epic; never
 *     writes an open/reopen state (invariants 1–3);
 *   - never closes when the native edge read failed, or when any child read
 *     that is not a droppable body-only typo failed (invariant 4 — #5210);
 *   - read-justified closure: a close happens only if every child in the list
 *     it read was done in the snapshot it read, with `state_reason`
 *     `completed` iff one of those children carries `agent::done`;
 *   - ground-truth closure on an honest read: closed ⇒ every ground-truth
 *     child is done at the moment of the close write;
 *   - liveness under `fc.scheduler()`: sibling Stories flipping to done and
 *     rolling up in any interleaving settle to "closed exactly when every
 *     child is done".
 *
 * Fault model. Per call: a child read throws; a child read returns null (a
 * 404); the native edge read throws; a child read or the native edge read
 * returns a *lagging* earlier snapshot. Silent native truncation is out of
 * model: the provider's contract is complete-or-throw
 * (`providers/github/sub-issues.js` throws past its page cap).
 *
 * Boundary — why the ground-truth form holds only on an honest read. Closure
 * is one-way by design, and a read that disagrees with ground truth can make
 * a close stale. Probing the strong form (ground-truth closure on *every*
 * rollup, seed 5424, `MANDREL_FC_NUM_RUNS` in the thousands) shrinks to two
 * such reads:
 *
 *   1. A lagging child snapshot. Child #1 is done and named only in the body;
 *      it is then reopened; the rollup's read of it lags one version and
 *      answers done — the Epic closes `completed` while #1 is open:
 *        AddBodyRow(#0), SetState(#0, null, open),
 *        RollUp(story=1, child #1 → { kind: 'lag', back: 1 })
 *      Every read it made was true of *some* moment, so the read-justified
 *      form still holds. A lagging native edge list is the same shape.
 *   2. A 404 for a child that exists but only the body checklist names. The
 *      rollup deliberately drops an unresolvable body-only id as a checklist
 *      typo (`readOneChild`), so a lying not-found reads exactly like a typo:
 *        child #1 open and body-only, child #2 closed and body-only,
 *        RollUp(story=1, parent lookup throws, child #1 → { kind: 'null' })
 *      closes the Epic over the open #1.
 *
 * Neither is a defect under this Story's triage: fixing staleness-induced
 * closure is a Non-Goal (closure is one-way), and the typo drop is the
 * documented trade-off. So the ground-truth property is asserted only on
 * rollups whose every read was honest, and the read-justified property on all.
 *
 * Every property takes its parameters from `tests/helpers/fast-check-config.js`
 * (pinned seed, bounded runs, `MANDREL_FC_SEED` / `MANDREL_FC_NUM_RUNS`).
 */

import assert from 'node:assert/strict';
import { after, before, describe, it, mock } from 'node:test';

import fc from 'fast-check';

import { Logger } from '../../../.agents/scripts/lib/Logger.js';
import { rollUpEpicForStory } from '../../../.agents/scripts/lib/orchestration/epic-rollup.js';
import { fcParams } from '../../helpers/fast-check-config.js';

const EPIC_ID = 100;
const DONE = 'agent::done';
const AGENT_STATES = [
  null,
  'agent::ready',
  'agent::executing',
  'agent::closing',
  'agent::blocked',
  DONE,
];
/** Body-checklist rows that resolve to no issue — the typo case. */
const TYPO_BASE = 900;
/** How far back a lagging read may reach into a record's history. */
const MAX_LAG = 3;
const FAULT_SLOTS = 8;

const clone = (v) => structuredClone(v);

/**
 * The ground-truth store: an Epic, its children with version histories, the
 * native edge list with its history, and the body checklist. Every write the
 * rollup makes lands in `writes`, stamped with ground truth at write time.
 */
class World {
  /**
   * @param {{ children: object[], typoIds: number[], epicClosed: boolean }} spec
   */
  constructor(spec) {
    this.epic = {
      id: EPIC_ID,
      nodeId: `I_epic_${EPIC_ID}`,
      labels: ['type::epic'],
      state: spec.epicClosed ? 'closed' : 'open',
      assignees: [],
    };
    this.children = new Map();
    const native = [];
    this.body = [];
    spec.children.forEach((c, i) => {
      const id = i + 1;
      this.children.set(id, [
        {
          id,
          labels: [c.epicTyped ? 'type::epic' : 'type::story'].concat(
            c.label ? [c.label] : [],
          ),
          state: c.closed ? 'closed' : 'open',
        },
      ]);
      if (c.inNative) native.push(id);
      if (c.inBody) this.body.push(id);
    });
    for (const t of spec.typoIds) this.body.push(TYPO_BASE + t);
    this.nativeHistory = [native];
    this.writes = [];
  }

  get childIds() {
    return [...this.children.keys()];
  }

  current(id) {
    const h = this.children.get(id);
    return h ? h[h.length - 1] : null;
  }

  /** The snapshot `back` versions before the current one, clamped. */
  lagging(id, back) {
    const h = this.children.get(id);
    return h[Math.max(0, h.length - 1 - back)];
  }

  get native() {
    return this.nativeHistory[this.nativeHistory.length - 1];
  }

  laggingNative(back) {
    const h = this.nativeHistory;
    return h[Math.max(0, h.length - 1 - back)];
  }

  editChild(id, edit) {
    const next = clone(this.current(id));
    edit(next);
    this.children.get(id).push(next);
  }

  setNative(ids) {
    this.nativeHistory.push([...new Set(ids)].sort((a, b) => a - b));
  }

  epicTicket() {
    const rows = this.body.map((id) => `- [ ] #${id}`).join('\n');
    return {
      ...clone(this.epic),
      body: `## Goal\n\nGroup them.\n\n## Stories\n\n${rows}\n`,
    };
  }

  /** The rollup's own child definition, applied to ground truth. */
  groundTruthChildren() {
    const ids = new Set([...this.native, ...this.body]);
    return [...ids]
      .map((id) => this.current(id))
      .filter((c) => c && !c.labels.includes('type::epic'));
  }

  allGroundTruthDone() {
    return this.groundTruthChildren().every(isDone);
  }
}

/** Done as `deriveParentState` counts it: the label, or a closed issue. */
function isDone(child) {
  return child.labels.includes(DONE) || child.state === 'closed';
}

/**
 * A provider over `world` serving one rollup's fault `plan`, recording what
 * each read actually returned in `log`. `gate` (optional) awaits before each
 * call so a scheduler can interleave calls.
 */
function makeProvider(world, plan, log, gate = async () => {}) {
  const childFault = (id) => plan.child[id % FAULT_SLOTS];
  return {
    async getParentIssue(storyId) {
      await gate(`getParentIssue(${storyId})`);
      if (plan.parent === 'throw') throw new Error('parent lookup 502');
      return world.native.includes(storyId) ? world.epicTicket() : null;
    },
    async listTicketsByLabel() {
      await gate('listTicketsByLabel');
      return [world.epicTicket()];
    },
    async getNativeSubIssues(nodeId) {
      await gate('getNativeSubIssues');
      assert.equal(nodeId, `I_epic_${EPIC_ID}`);
      if (plan.native.kind === 'throw') {
        log.nativeFailed = true;
        throw new Error('native sub-issue read 502');
      }
      const ids =
        plan.native.kind === 'lag'
          ? world.laggingNative(plan.native.back)
          : world.native;
      if (ids !== world.native) log.dishonest = true;
      log.nativeIds = [...ids];
      return [...ids];
    },
    async getTicket(id) {
      await gate(`getTicket(${id})`);
      const fault = childFault(id);
      if (fault.kind === 'throw') {
        log.childThrew = true;
        throw new Error(`child #${id} read 502`);
      }
      const truth = world.current(id);
      if (fault.kind === 'null' || !truth) {
        if (truth) log.dishonest = true;
        log.nulls.push(id);
        return null;
      }
      const snap = fault.kind === 'lag' ? world.lagging(id, fault.back) : truth;
      if (snap !== truth) log.dishonest = true;
      log.reads.set(id, clone(snap));
      return clone(snap);
    },
    async updateTicket(id, patch) {
      await gate(`updateTicket(${id})`);
      world.writes.push({
        id,
        patch: clone(patch),
        allDoneAtWrite: world.allGroundTruthDone(),
        log,
      });
      if (patch.state === 'closed') world.epic.state = 'closed';
      if (Array.isArray(patch.addAssignees)) {
        world.epic.assignees.push(...patch.addAssignees);
      }
    },
  };
}

function freshLog() {
  return {
    nativeFailed: false,
    childThrew: false,
    dishonest: false,
    nativeIds: null,
    nulls: [],
    reads: new Map(),
  };
}

const columnSync = { setColumn: async () => ({ status: 'synced' }) };

/**
 * Invariants 1–4 plus the two closure forms, checked over the writes one
 * rollup made. `epicWasOpen` / `bodyAtRead` are the Epic as the rollup saw it.
 */
function assertRollupInvariants({ writes, log, epicWasOpen, bodyAtRead }) {
  for (const { id, patch } of writes) {
    assert.equal(id, EPIC_ID, 'the rollup writes only to the Epic');
    assert.doesNotMatch(
      JSON.stringify(patch),
      /agent::/,
      'invariant 1: the Epic never gains an agent::* label',
    );
    if ('state' in patch) {
      assert.equal(patch.state, 'closed', 'invariant 2: closure is one-way');
    }
  }
  const closes = writes.filter((w) => w.patch.state === 'closed');
  if (closes.length === 0) return;
  assert.equal(closes.length, 1, 'one rollup closes at most once');
  assert.ok(epicWasOpen, 'an already-closed Epic is never re-closed');

  // Invariant 4: an authoritative child list.
  assert.equal(log.nativeFailed, false, 'closed on a failed native read');
  assert.equal(log.childThrew, false, 'closed on a failed child read');
  for (const id of log.nulls) {
    const droppable =
      bodyAtRead.includes(id) && !(log.nativeIds ?? []).includes(id);
    assert.ok(droppable, `closed over an unreadable native child #${id}`);
  }

  // Read-justified closure.
  const read = [...log.reads.values()].filter(
    (c) => !c.labels.includes('type::epic'),
  );
  assert.ok(read.length > 0, 'closed with no child read');
  assert.ok(
    read.every(isDone),
    'closed over a child the rollup itself read as open',
  );
  const landed = read.some((c) => c.labels.includes(DONE));
  assert.equal(
    closes[0].patch.state_reason,
    landed ? 'completed' : 'not_planned',
    'state_reason must follow whether a read child landed',
  );

  // Ground-truth closure, on an honest read only (see the header).
  if (!log.dishonest) {
    assert.ok(
      closes[0].allDoneAtWrite,
      'closed while a ground-truth child was open',
    );
  }
}

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

const rare = (n) => fc.integer({ min: 0, max: n }).map((v) => v === 0);

/** Biased toward `done` so closure — the write under test — is common. */
const agentStateArb = fc.oneof(
  { arbitrary: fc.constant(DONE), weight: 6 },
  { arbitrary: fc.constantFrom(...AGENT_STATES), weight: 2 },
);

const childArb = fc.record({
  label: agentStateArb,
  closed: rare(3),
  epicTyped: rare(8),
  inNative: fc.boolean(),
  inBody: fc.boolean(),
});

const worldArb = fc.record({
  children: fc.array(childArb, { minLength: 1, maxLength: 5 }),
  typoIds: fc.uniqueArray(fc.integer({ min: 0, max: 2 }), { maxLength: 2 }),
  epicClosed: rare(9),
  owner: fc.constantFrom('operator', null),
});

const OK = { kind: 'ok' };
const lagArb = fc
  .integer({ min: 1, max: MAX_LAG })
  .map((back) => ({ kind: 'lag', back }));

const childFaultArb = fc.oneof(
  { arbitrary: fc.constant(OK), weight: 8 },
  { arbitrary: fc.constant({ kind: 'throw' }), weight: 1 },
  { arbitrary: fc.constant({ kind: 'null' }), weight: 1 },
  { arbitrary: lagArb, weight: 1 },
);

const planArb = fc.record({
  parent: fc.oneof(
    { arbitrary: fc.constant('ok'), weight: 4 },
    { arbitrary: fc.constant('throw'), weight: 1 },
  ),
  native: fc.oneof(
    { arbitrary: fc.constant(OK), weight: 4 },
    { arbitrary: fc.constant({ kind: 'throw' }), weight: 2 },
    { arbitrary: lagArb, weight: 1 },
  ),
  child: fc.array(childFaultArb, {
    minLength: FAULT_SLOTS,
    maxLength: FAULT_SLOTS,
  }),
});

// ---------------------------------------------------------------------------
// Commands — each mutates ground truth or runs one rollup against it.
// ---------------------------------------------------------------------------

const pick = (world, idx) => world.childIds[idx % world.childIds.length];

class SetStateCommand {
  constructor(idx, label, closed) {
    Object.assign(this, { idx, label, closed });
  }
  check() {
    return true;
  }
  run(_m, world) {
    const labels = this.label ? [this.label] : [];
    world.editChild(pick(world, this.idx), (c) => {
      c.labels = c.labels.filter((l) => !l.startsWith('agent::'));
      c.labels.push(...labels);
      c.state = this.closed ? 'closed' : 'open';
    });
  }
  toString() {
    return `SetState(#${this.idx}, ${this.label}, ${this.closed ? 'closed' : 'open'})`;
  }
}

class LinkCommand {
  constructor(idx, linked) {
    Object.assign(this, { idx, linked });
  }
  check() {
    return true;
  }
  run(_m, world) {
    const id = pick(world, this.idx);
    world.setNative(
      this.linked
        ? [...world.native, id]
        : world.native.filter((n) => n !== id),
    );
  }
  toString() {
    return `${this.linked ? 'Link' : 'Unlink'}(#${this.idx})`;
  }
}

class AddBodyRowCommand {
  constructor(idx) {
    this.idx = idx;
  }
  check() {
    return true;
  }
  run(_m, world) {
    const id = pick(world, this.idx);
    if (!world.body.includes(id)) world.body.push(id);
  }
  toString() {
    return `AddBodyRow(#${this.idx})`;
  }
}

class RollUpCommand {
  constructor(storyPick, plan, owner) {
    Object.assign(this, { storyPick, plan, owner });
  }
  check() {
    return true;
  }
  async run(_m, world) {
    // One id past the last child names a Story in no Epic.
    const storyId = (this.storyPick % (world.childIds.length + 1)) + 1;
    const log = freshLog();
    const epicWasOpen = world.epic.state === 'open';
    const bodyAtRead = [...world.body];
    const before = world.writes.length;
    const result = await rollUpEpicForStory({
      storyId,
      provider: makeProvider(world, this.plan, log),
      columnSync,
      owner: this.owner,
    });
    assert.ok(result && typeof result === 'object', 'invariant 3: resolves');
    assertRollupInvariants({
      writes: world.writes.slice(before),
      log,
      epicWasOpen,
      bodyAtRead,
    });
  }
  toString() {
    return `RollUp(story=${this.storyPick}, ${JSON.stringify(this.plan)}, owner=${this.owner})`;
  }
}

const idxArb = fc.nat({ max: 7 });
const commandsArb = fc.commands(
  [
    fc
      .tuple(idxArb, agentStateArb, rare(3))
      .map(([i, l, c]) => new SetStateCommand(i, l, c)),
    fc.tuple(idxArb, fc.boolean()).map(([i, l]) => new LinkCommand(i, l)),
    idxArb.map((i) => new AddBodyRowCommand(i)),
    fc
      .tuple(fc.nat({ max: 7 }), planArb, fc.constantFrom('operator', null))
      .map(([s, p, o]) => new RollUpCommand(s, p, o)),
  ],
  { maxCommands: 16 },
);

// ---------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------

describe('rollUpEpicForStory — properties (fast-check)', () => {
  before(() => {
    mock.method(Logger, 'warn', () => {});
    mock.method(Logger, 'info', () => {});
  });
  after(() => mock.restoreAll());

  it('holds invariants 1–4 and both closure forms over any command sequence and fault mix', async () => {
    await fc.assert(
      fc.asyncProperty(worldArb, commandsArb, async (spec, cmds) => {
        const world = new World(spec);
        await fc.asyncModelRun(() => ({ model: {}, real: world }), cmds);
      }),
      fcParams(),
    );
  });

  it('settles closed exactly when every child is done, in any sibling interleaving (fc.scheduler)', async () => {
    const siblingArb = fc
      .array(
        fc.record({
          start: fc.constantFrom(
            'agent::ready',
            'agent::executing',
            'agent::closing',
            'agent::blocked',
          ),
          flips: fc.boolean(),
          inBody: fc.boolean(),
        }),
        { minLength: 2, maxLength: 5 },
      )
      .filter((cs) => cs.some((c) => c.flips));

    await fc.assert(
      fc.asyncProperty(fc.scheduler(), siblingArb, async (s, siblings) => {
        const world = new World({
          children: siblings.map((c) => ({
            label: c.start,
            closed: false,
            epicTyped: false,
            inNative: true,
            inBody: c.inBody,
          })),
          typoIds: [],
          epicClosed: false,
        });
        const honest = {
          parent: 'ok',
          native: OK,
          child: Array(FAULT_SLOTS).fill(OK),
        };
        const gate = (label) => s.schedule(Promise.resolve(label), label);
        const tasks = siblings.flatMap((c, i) => {
          if (!c.flips) return [];
          const storyId = i + 1;
          const log = freshLog();
          return [
            s.schedule(Promise.resolve(), `flip #${storyId}`).then(async () => {
              world.editChild(storyId, (child) => {
                child.labels = ['type::story', DONE];
              });
              await rollUpEpicForStory({
                storyId,
                provider: makeProvider(world, honest, log, gate),
                columnSync,
                owner: null,
              });
            }),
          ];
        });
        await s.waitFor(Promise.all(tasks));

        for (const w of world.writes) {
          assert.doesNotMatch(JSON.stringify(w.patch), /agent::/);
          if ('state' in w.patch) {
            assert.equal(w.patch.state, 'closed');
            assert.ok(w.allDoneAtWrite, 'closed over an open sibling');
          }
        }
        const allDone = world.allGroundTruthDone();
        assert.equal(
          world.epic.state === 'closed',
          allDone,
          allDone
            ? 'every child is done but the Epic was left open'
            : 'the Epic closed with a child still open',
        );
      }),
      fcParams(),
    );
  });
});
