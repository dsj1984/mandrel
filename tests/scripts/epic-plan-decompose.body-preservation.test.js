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
 * GH issue body — taking the hand-authored Epic spec AND the
 * `## Planning Artifacts` section with it, which broke
 * `/epic-deliver`'s start gate (parseLinkedIssues → null) and the
 * cascade-close walk in `epic-deliver-finalize.js`.
 *
 * The fix lives in two cooperating places (defence in depth):
 *
 *   1. `epic-spec-reconciler-diff.js#fieldChanges` — skip the body
 *      diff entirely when the spec did not carry a body string
 *      (covered by `epic-spec-reconciler.diff.test.js`).
 *
 *   2. `epic-plan-decompose.js#runDecomposePhase` — pass the Epic's
 *      live body through to the spec renderer so the persisted YAML
 *      is the SSOT, and call `ensurePlanningArtifacts` so the
 *      Planning Artifacts section is appended exactly once if missing.
 *
 * The tests below drive `runDecomposePhase` with a capture
 * `renderSpecFn` and assert the body the renderer would project; plus
 * direct unit coverage of `ensurePlanningArtifacts`.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  ensurePlanningArtifacts,
  runDecomposePhase,
} from '../../.agents/scripts/epic-plan-decompose.js';
import { writeSpec } from '../../.agents/scripts/lib/spec/index.js';

const EPIC_ID = 2173;
const PRD_ID = 2185;
const TECH_SPEC_ID = 2186;
const ACCEPTANCE_SPEC_ID = 2187;

const NON_TRIVIAL_BODY_PROSE =
  '## Context\n\n' +
  'A non-trivial Epic body that mirrors the >1KB hand-authored body '
    .repeat(20)
    .trim() +
  '\n\n## Goal\n\nKeep the body verbatim through Phase 8 persist.\n';

const PLANNING_ARTIFACTS_SECTION =
  `\n\n## Planning Artifacts\n` +
  `- [ ] PRD: #${PRD_ID}\n` +
  `- [ ] Tech Spec: #${TECH_SPEC_ID}\n` +
  `- [ ] Acceptance Spec: #${ACCEPTANCE_SPEC_ID}\n`;

const NON_TRIVIAL_BODY_WITH_ARTIFACTS =
  NON_TRIVIAL_BODY_PROSE + PLANNING_ARTIFACTS_SECTION;

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
    linkedIssues: {
      prd: PRD_ID,
      techSpec: TECH_SPEC_ID,
      acceptanceSpec: ACCEPTANCE_SPEC_ID,
    },
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
      slug: 'feature-a',
      type: 'feature',
      title: 'Feature A',
      body: 'feature body',
      labels: ['type::feature'],
      parent_slug: '',
      depends_on: [],
    },
    {
      slug: 'story-one',
      type: 'story',
      title: 'Story One',
      body: 'story body',
      labels: ['type::story'],
      parent_slug: 'feature-a',
      depends_on: [],
    },
    {
      slug: 'task-one',
      type: 'task',
      title: 'Task One',
      body: {
        goal: 'do thing',
        changes: ['package.json: change a thing'],
        acceptance: ['done'],
        verify: ['npm test'],
      },
      labels: ['type::task'],
      parent_slug: 'story-one',
      depends_on: [],
    },
  ];
}

const stubSpawnSync = () => ({ status: 0, stdout: '', stderr: '' });

describe('ensurePlanningArtifacts (Story #2283)', () => {
  const linkedIssues = {
    prd: PRD_ID,
    techSpec: TECH_SPEC_ID,
    acceptanceSpec: ACCEPTANCE_SPEC_ID,
  };

  it('returns the body verbatim when the section is already present', () => {
    const out = ensurePlanningArtifacts(
      NON_TRIVIAL_BODY_WITH_ARTIFACTS,
      linkedIssues,
    );
    assert.equal(
      out,
      NON_TRIVIAL_BODY_WITH_ARTIFACTS,
      'body must be byte-identical when the section already exists',
    );
  });

  it('appends the Planning Artifacts section exactly once when missing', () => {
    const out = ensurePlanningArtifacts(NON_TRIVIAL_BODY_PROSE, linkedIssues);
    assert.equal(
      out,
      NON_TRIVIAL_BODY_PROSE + PLANNING_ARTIFACTS_SECTION,
      'section must be appended verbatim, prose preserved byte-identical',
    );
    const occurrences = (out.match(/## Planning Artifacts/g) ?? []).length;
    assert.equal(occurrences, 1, 'section must appear exactly once');
  });

  it('is idempotent — running twice yields the same result', () => {
    const once = ensurePlanningArtifacts(NON_TRIVIAL_BODY_PROSE, linkedIssues);
    const twice = ensurePlanningArtifacts(once, linkedIssues);
    assert.equal(twice, once);
  });

  it('skips PRD / Tech Spec / Acceptance Spec lines whose id is null', () => {
    const out = ensurePlanningArtifacts('original', {
      prd: PRD_ID,
      techSpec: null,
      acceptanceSpec: null,
    });
    assert.equal(
      out,
      `original\n\n## Planning Artifacts\n- [ ] PRD: #${PRD_ID}\n`,
    );
  });

  it('returns the body unchanged when no linkedIssues are resolvable', () => {
    const out = ensurePlanningArtifacts('original', {
      prd: null,
      techSpec: null,
      acceptanceSpec: null,
    });
    assert.equal(out, 'original');
  });

  it('returns an empty string unchanged when the body and linkedIssues are both empty', () => {
    const out = ensurePlanningArtifacts('', null);
    assert.equal(out, '');
  });
});

describe('runDecomposePhase — Epic body preservation (Story #2283)', () => {
  it('passes the Epic body byte-identical to renderSpec when Planning Artifacts is already present', async () => {
    assert.ok(
      NON_TRIVIAL_BODY_WITH_ARTIFACTS.length > 1024,
      'fixture body must exceed 1KB to mirror the bug-report scale',
    );
    const provider = buildStubProvider({
      epicId: EPIC_ID,
      epicBody: NON_TRIVIAL_BODY_WITH_ARTIFACTS,
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
        features: [],
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
      NON_TRIVIAL_BODY_WITH_ARTIFACTS,
      'renderSpec must receive the Epic body byte-identical to the pre-persist state',
    );
    // AC #3 from Story #2283 — the spec we hand to the reconciler
    // carries the body, so the diff would not emit `body → ""`.
    assert.notEqual(captured.epic.body, '');
  });

  it('appends Planning Artifacts when missing before handing to renderSpec', async () => {
    const provider = buildStubProvider({
      epicId: EPIC_ID,
      epicBody: NON_TRIVIAL_BODY_PROSE,
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
        features: [],
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
    assert.ok(
      captured.epic.body.startsWith(NON_TRIVIAL_BODY_PROSE),
      'the prose portion of the Epic body must be preserved byte-identical at the head',
    );
    assert.ok(
      captured.epic.body.includes('## Planning Artifacts'),
      'Planning Artifacts section must be appended when missing',
    );
    const occurrences = (
      captured.epic.body.match(/## Planning Artifacts/g) ?? []
    ).length;
    assert.equal(occurrences, 1, 'section must appear exactly once');
    assert.ok(captured.epic.body.includes(`- [ ] PRD: #${PRD_ID}`));
    assert.ok(captured.epic.body.includes(`- [ ] Tech Spec: #${TECH_SPEC_ID}`));
    assert.ok(
      captured.epic.body.includes(
        `- [ ] Acceptance Spec: #${ACCEPTANCE_SPEC_ID}`,
      ),
    );
  });
});
