/**
 * tests/scripts/epic-plan-decompose.body-preservation.test.js
 *
 * Regression coverage for Story #2283 — `epic-plan-decompose.js`
 * Phase 8 (persist) was blanking the Epic body during the reconciler
 * apply call.
 *
 * Pre-fix history (2026-05-17, Epic #2173): the persist half rendered
 * the Epic spec entry from `{ id, title }` only; the structural diff
 * engine treated the spec's `undefined` body as `""` and emitted
 * `body: <17KB body> → ""`. The reconciler apply phase then wiped the
 * GH issue body — taking the hand-authored Epic spec with it.
 *
 * The fix lives in two cooperating places (defence in depth):
 *
 *   1. `epic-spec-reconciler-diff.js#fieldChanges` — skip the body
 *      diff entirely when the spec did not carry a body string
 *      (covered by `epic-spec-reconciler.diff.test.js`).
 *
 *   2. `epic-plan-decompose.js#runDecomposePhase` — pass the Epic's
 *      live body through to the spec renderer so the persisted YAML
 *      is the SSOT.
 *
 * Story #4324 retired the `context::*` ticket classes and the
 * machine-managed `## Planning Artifacts` checklist writer
 * (`ensurePlanningArtifacts` is deleted): the Epic body carries the
 * folded Tech Spec / Acceptance Table as managed sections, and Phase 8
 * hands that body to `renderSpec` verbatim — it neither appends nor
 * strips anything (the legacy-checklist strip belongs to Phase 7's
 * `planEpic`).
 *
 * The tests below drive `runDecomposePhase` with a capture
 * `renderSpecFn` and assert the body the renderer would project.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { upsertEpicSection } from '../../.agents/scripts/lib/epic-body-sections.js';
import { runDecomposePhase } from '../../.agents/scripts/lib/orchestration/epic-plan-decompose/phases/persist.js';
import { writeSpec } from '../../.agents/scripts/lib/spec/index.js';

const EPIC_ID = 2173;

const NON_TRIVIAL_BODY_PROSE =
  '## Context\n\n' +
  'A non-trivial Epic body that mirrors the >1KB hand-authored body '
    .repeat(20)
    .trim() +
  '\n\n## Goal\n\nKeep the body verbatim through Phase 8 persist.\n';

// Story #4324 — the folded Tech Spec managed section the decompose input
// gate requires on every Epic body.
const NON_TRIVIAL_SECTIONED_BODY = upsertEpicSection(
  NON_TRIVIAL_BODY_PROSE,
  'techSpec',
  '## Delivery Slicing\n\n| Slice | What ships | Independent? |\n| --- | --- | --- |\n| 1 | Everything | yes |',
);

// Historical Epic bodies may still carry the retired machine-managed
// checklist (forward-only cutover, no backfill). Phase 8 must pass it
// through verbatim — never re-append, never strip.
const LEGACY_PLANNING_ARTIFACTS_SECTION =
  '\n\n## Planning Artifacts\n- [ ] Tech Spec: #2186\n- [ ] Acceptance Spec: #2187\n';

const BODY_WITH_LEGACY_ARTIFACTS =
  NON_TRIVIAL_SECTIONED_BODY + LEGACY_PLANNING_ARTIFACTS_SECTION;

let sandbox;
let epicsDir;

beforeEach(() => {
  sandbox = mkdtempSync(path.join(os.tmpdir(), 'epic-body-preservation-'));
  epicsDir = path.join(sandbox, '.agents', 'epics');
});

afterEach(() => {
  if (sandbox) rmSync(sandbox, { recursive: true, force: true });
});

function buildStubProvider({ epicId, epicBody }) {
  const issues = new Map();
  const comments = new Map();
  let nextCommentId = 1000;
  let nextId = epicId + 1;
  issues.set(epicId, {
    id: epicId,
    title: 'Body-Preservation Epic',
    body: epicBody,
    labels: ['type::epic', 'agent::review-spec'],
    state: 'open',
  });
  return {
    issues,
    async getEpic(id) {
      return issues.get(id);
    },
    async getTicket(id) {
      return issues.get(id);
    },
    async getTickets() {
      return Array.from(issues.values()).filter((t) => t.id !== epicId);
    },
    // Story #3455 — decompose's resume-indexing path enumerates children
    // via the scoped getSubTickets; mirror the same child set.
    async getSubTickets() {
      return Array.from(issues.values()).filter((t) => t.id !== epicId);
    },
    async createTicket(_parentId, payload) {
      const id = nextId++;
      issues.set(id, {
        id,
        title: payload.title,
        body: payload.body ?? '',
        labels: payload.labels ?? [],
        state: 'open',
      });
      return { id, url: `https://stub/issues/${id}` };
    },
    async updateTicket(id, patch) {
      const cur = issues.get(id) ?? { id, labels: [] };
      if (patch.title) cur.title = patch.title;
      if (patch.body !== undefined) cur.body = patch.body;
      if (Array.isArray(patch.labels)) cur.labels = patch.labels;
      if (
        patch.labels &&
        typeof patch.labels === 'object' &&
        !Array.isArray(patch.labels)
      ) {
        const existing = new Set(cur.labels ?? []);
        for (const add of patch.labels.add ?? []) existing.add(add);
        for (const rm of patch.labels.remove ?? []) existing.delete(rm);
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
      const cid = nextCommentId++;
      const arr = comments.get(id) ?? [];
      const body = typeof payload === 'string' ? payload : payload.body;
      arr.push({ id: cid, body });
      comments.set(id, arr);
      return { id: cid, body };
    },
    async deleteComment() {
      return true;
    },
    async updateComment() {
      return null;
    },
    async addSubIssue() {
      return { ok: true };
    },
    async removeSubIssue() {
      return { ok: true };
    },
    async reconcileSubIssueLinks() {
      return {
        totalExpected: 1,
        alreadyLinked: 1,
        reconciled: 0,
        failed: 0,
        failures: [],
      };
    },
    primeTicketCache() {},
  };
}

function buildFixtureTickets() {
  return [
    {
      slug: 'story-one',
      type: 'story',
      title: 'Story One',
      labels: ['type::story'],
      depends_on: [],
      acceptance: ['done'],
      verify: ['npm test (unit)'],
      body: {
        goal: 'do thing',
        changes: ['package.json: change a thing'],
        acceptance: ['done'],
        verify: ['npm test (unit)'],
      },
    },
    // Story #3777 — a Feature MUST carry >=2 Stories.
    {
      slug: 'story-two',
      type: 'story',
      title: 'Story Two',
      labels: ['type::story'],
      depends_on: [],
      acceptance: ['done'],
      verify: ['npm test (unit)'],
      body: {
        goal: 'do another thing',
        changes: ['README.md: change another thing'],
        acceptance: ['done'],
        verify: ['npm test (unit)'],
      },
    },
  ];
}

const stubSpawnSync = () => ({ status: 0, stdout: '', stderr: '' });

describe('runDecomposePhase — Epic body preservation (Story #2283)', () => {
  it('passes a legacy body (with a historical Planning Artifacts section) byte-identical to renderSpec', async () => {
    assert.ok(
      BODY_WITH_LEGACY_ARTIFACTS.length > 1024,
      'fixture body must exceed 1KB to mirror the bug-report scale',
    );
    const provider = buildStubProvider({
      epicId: EPIC_ID,
      epicBody: BODY_WITH_LEGACY_ARTIFACTS,
    });
    const tickets = buildFixtureTickets();
    const writeSpecOverride = (id, spec) => writeSpec(id, spec, { epicsDir });

    let captured;
    const renderSpecOverride = (_validatedTickets, opts) => {
      captured = opts;
      // Return a minimal spec the writeSpec call can persist + the
      // (stubbed) reconciler is fed via spawnSync.
      return {
        epic: {
          id: opts.epic.id,
          title: opts.epic.title,
          body: opts.epic.body,
        },
        stories: [],
      };
    };

    await runDecomposePhase(
      EPIC_ID,
      provider,
      { tickets },
      {},
      {
        spawnSync: stubSpawnSync,
        writeSpecFn: writeSpecOverride,
        renderSpecFn: renderSpecOverride,
        skipHealthcheck: true,
      },
    );

    assert.ok(captured, 'renderSpec must have been called');
    assert.equal(
      captured.epic.body,
      BODY_WITH_LEGACY_ARTIFACTS,
      'renderSpec must receive the Epic body byte-identical to the pre-persist state — legacy checklist content included, untouched',
    );
    // AC #3 from Story #2283 — the spec we hand to the reconciler
    // carries the body, so the diff would not emit `body → ""`.
    assert.notEqual(captured.epic.body, '');
    // Story #4324 — decompose neither strips nor duplicates the historical
    // section; it appears exactly as often as the input carried it.
    const occurrences = (
      captured.epic.body.match(/## Planning Artifacts/g) ?? []
    ).length;
    assert.equal(occurrences, 1);
  });

  it('passes the body verbatim without appending any Planning Artifacts section (Story #4324)', async () => {
    // The retired ensurePlanningArtifacts append is gone: a body carrying
    // only the managed planning sections flows through byte-identical.
    const provider = buildStubProvider({
      epicId: EPIC_ID,
      epicBody: NON_TRIVIAL_SECTIONED_BODY,
    });
    const tickets = buildFixtureTickets();
    const writeSpecOverride = (id, spec) => writeSpec(id, spec, { epicsDir });

    let captured;
    const renderSpecOverride = (_validatedTickets, opts) => {
      captured = opts;
      return {
        epic: {
          id: opts.epic.id,
          title: opts.epic.title,
          body: opts.epic.body,
        },
        stories: [],
      };
    };

    await runDecomposePhase(
      EPIC_ID,
      provider,
      { tickets },
      {},
      {
        spawnSync: stubSpawnSync,
        writeSpecFn: writeSpecOverride,
        renderSpecFn: renderSpecOverride,
        skipHealthcheck: true,
      },
    );

    assert.ok(captured, 'renderSpec must have been called');
    assert.equal(
      captured.epic.body,
      NON_TRIVIAL_SECTIONED_BODY,
      'the Epic body must flow through to renderSpec byte-identical',
    );
    assert.ok(
      !captured.epic.body.includes('## Planning Artifacts'),
      'no Planning Artifacts section may be appended — the checklist writer is retired (Story #4324)',
    );
  });
});
