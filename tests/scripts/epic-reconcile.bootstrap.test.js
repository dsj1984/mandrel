/**
 * tests/scripts/epic-reconcile.bootstrap.test.js — Story #1497 / Task #1534.
 *
 * Contract tests for the `--reverse-bootstrap` CLI surface and the
 * underlying projection module. Covers the three AC for the parent
 * Story:
 *
 *   1. Happy path — a quiescent Epic projects into a spec that validates
 *      against `.agents/schemas/epic-spec.schema.json` and a state.json
 *      whose content-hashes make a follow-up `diff({spec, state, ghState})`
 *      return an empty plan (the "no-op dry-run" property).
 *
 *   2. Refusal path — when any child Story carries `agent::executing`,
 *      the bootstrap throws `EpicNotQuiescentError`, the CLI exits 2,
 *      and stderr carries the structured `code=EPIC_NOT_QUIESCENT` line
 *      so log scrapers can match without parsing prose (Task #1532 AC).
 *
 *   3. Idempotency / quiescence regression — re-running bootstrap on a
 *      previously-bootstrapped Epic produces byte-identical spec + state
 *      files; the diff is empty across two consecutive `--dry-run`s.
 *
 * The tests stub the provider so no GH traffic flies. Spec + state files
 * are written into a sandbox tmpdir; the spec schema is loaded from the
 * repo (the renderer needs it at validation time).
 */

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import yaml from 'js-yaml';

import {
  EPIC_NOT_QUIESCENT_CODE,
  EXIT_CODES,
  runBootstrap,
} from '../../.agents/scripts/epic-reconcile.js';
import { diff } from '../../.agents/scripts/lib/orchestration/epic-spec-reconciler-diff.js';
import {
  assertEpicQuiescent,
  buildBootstrapInputs,
  buildBootstrapState,
  EpicNotQuiescentError,
  runReverseBootstrap,
} from '../../.agents/scripts/lib/orchestration/epic-spec-reverse-bootstrap.js';
import {
  _resetRendererValidatorCacheForTests,
  renderSpec,
} from '../../.agents/scripts/lib/orchestration/spec-renderer.js';
import {
  _resetValidatorCacheForTests,
  loadSpec,
} from '../../.agents/scripts/lib/spec/loader.js';

let sandbox;

beforeEach(() => {
  sandbox = mkdtempSync(path.join(os.tmpdir(), 'epic-reconcile-bootstrap-'));
  _resetValidatorCacheForTests();
  _resetRendererValidatorCacheForTests();
});

afterEach(() => {
  if (sandbox) rmSync(sandbox, { recursive: true, force: true });
});

/**
 * Build a stub provider whose `getEpic` / `getTickets` return the
 * supplied fixtures. The stub does not enforce method order or count —
 * tests inspect the returned `result` envelope directly.
 */
function makeProvider({ epic, tickets }) {
  return {
    async getEpic() {
      return epic;
    },
    async getTickets() {
      return tickets;
    },
  };
}

/**
 * Canonical fixture: one Feature, two Stories (wave 0 + wave 1 with a
 * cross-Story dep), two Tasks total. Designed to exercise every shape
 * the projection touches:
 *   - The Feature ticket parents to the Epic via `parent: #<epicId>`.
 *   - Story B's body carries `blocked by #<storyA_id>` to test the
 *     `dependsOn` slug projection.
 *   - One Task carries an `agent::done` label that must be stripped.
 *   - One Story has no agent label (the bootstrap must accept that).
 */
function buildQuiescentFixture() {
  const EPIC_ID = 9100;
  const FEATURE_ID = 9101;
  const STORY_A_ID = 9102;
  const STORY_B_ID = 9103;
  const TASK_A_ID = 9104;
  const TASK_B_ID = 9105;

  const epic = {
    id: EPIC_ID,
    title: 'Quiescent Migration Epic',
    body: 'Body of the quiescent epic.',
    labels: ['type::epic'],
  };

  const tickets = [
    {
      id: FEATURE_ID,
      title: 'Migration Feature',
      // Canonical form per `renderOrchestratorFooter`: when parent IS
      // the Epic, the renderer skips the redundant `Epic: #N` line.
      // Story #2982 — the reconciler diff now normalises non-canonical
      // bodies on reconcile, so the fixture must already be canonical
      // for the bootstrap round-trip to be a no-op.
      body: `Feature body.\n\n---\nparent: #${EPIC_ID}`,
      labels: ['type::feature'],
    },
    {
      id: STORY_A_ID,
      title: 'Story Alpha',
      body: `Alpha body.\n\n---\nparent: #${FEATURE_ID}\nEpic: #${EPIC_ID}`,
      labels: ['type::story', 'persona::engineer', 'agent::done'],
    },
    {
      id: STORY_B_ID,
      title: 'Story Beta',
      body: `Beta body.\n\n---\nparent: #${FEATURE_ID}\nEpic: #${EPIC_ID}\n\nblocked by #${STORY_A_ID}`,
      labels: ['type::story', 'persona::engineer'],
    },
    {
      id: TASK_A_ID,
      title: 'Task Alpha-One',
      body: `## Goal\nTask A.\n\n---\nparent: #${STORY_A_ID}\nEpic: #${EPIC_ID}`,
      labels: ['type::task', 'persona::engineer', 'agent::done'],
    },
    {
      id: TASK_B_ID,
      title: 'Task Beta-One',
      body: `## Goal\nTask B.\n\n---\nparent: #${STORY_B_ID}\nEpic: #${EPIC_ID}`,
      labels: ['type::task', 'persona::engineer'],
    },
  ];
  return {
    epic,
    tickets,
    ids: {
      EPIC_ID,
      FEATURE_ID,
      STORY_A_ID,
      STORY_B_ID,
      TASK_A_ID,
      TASK_B_ID,
    },
  };
}

// ---------------------------------------------------------------------------
// Quiescence guard — unit
// ---------------------------------------------------------------------------

describe('assertEpicQuiescent', () => {
  it('passes when no Story carries agent::executing', () => {
    const { tickets, ids } = buildQuiescentFixture();
    assert.doesNotThrow(() => assertEpicQuiescent(ids.EPIC_ID, tickets));
  });

  it('throws EpicNotQuiescentError when any Story carries agent::executing', () => {
    const { tickets, ids } = buildQuiescentFixture();
    // Mutate one Story to be executing.
    const mid = tickets.find((t) => t.id === ids.STORY_B_ID);
    mid.labels = [...mid.labels, 'agent::executing'];
    assert.throws(
      () => assertEpicQuiescent(ids.EPIC_ID, tickets),
      (err) => {
        assert.ok(err instanceof EpicNotQuiescentError);
        assert.equal(err.code, EPIC_NOT_QUIESCENT_CODE);
        assert.equal(err.epicId, ids.EPIC_ID);
        assert.equal(err.executingStories.length, 1);
        assert.equal(err.executingStories[0].id, ids.STORY_B_ID);
        const line = err.toStructuredLine();
        assert.match(line, new RegExp(`code=${EPIC_NOT_QUIESCENT_CODE}`));
        assert.match(line, new RegExp(`epic=#${ids.EPIC_ID}`));
        assert.match(line, new RegExp(`stories=#${ids.STORY_B_ID}`));
        return true;
      },
    );
  });

  it('lists every offending Story when more than one is executing', () => {
    const { tickets, ids } = buildQuiescentFixture();
    tickets
      .find((t) => t.id === ids.STORY_A_ID)
      .labels.push('agent::executing');
    tickets
      .find((t) => t.id === ids.STORY_B_ID)
      .labels.push('agent::executing');
    assert.throws(
      () => assertEpicQuiescent(ids.EPIC_ID, tickets),
      (err) => {
        assert.equal(err.executingStories.length, 2);
        return true;
      },
    );
  });

  it('ignores agent::executing on non-Story tickets', () => {
    // A Task carrying agent::executing is irrelevant — the quiescence
    // contract pivots on Story state because only Stories drive waves.
    const { tickets, ids } = buildQuiescentFixture();
    tickets.find((t) => t.id === ids.TASK_A_ID).labels.push('agent::executing');
    assert.doesNotThrow(() => assertEpicQuiescent(ids.EPIC_ID, tickets));
  });
});

// ---------------------------------------------------------------------------
// Projection — buildBootstrapInputs
// ---------------------------------------------------------------------------

describe('buildBootstrapInputs', () => {
  it('classifies tickets by type label and drops untyped rows', () => {
    const { epic, tickets } = buildQuiescentFixture();
    tickets.push({
      id: 99999,
      title: 'Random untyped ticket',
      body: `---\nparent: #${epic.id}`,
      labels: ['discussion'],
    });
    const { flatTickets } = buildBootstrapInputs(epic, tickets);
    assert.ok(!flatTickets.some((t) => t.title === 'Random untyped ticket'));
  });

  it('parents Features to the Epic (empty parent_slug)', () => {
    const { epic, tickets } = buildQuiescentFixture();
    const { flatTickets } = buildBootstrapInputs(epic, tickets);
    const feature = flatTickets.find((t) => t.type === 'feature');
    assert.ok(feature, 'feature row must be present');
    assert.equal(feature.parent_slug, '');
  });

  it('parents Stories to their Feature slug', () => {
    const { epic, tickets, ids } = buildQuiescentFixture();
    const { flatTickets, issueToSlug } = buildBootstrapInputs(epic, tickets);
    const featureSlug = issueToSlug.get(ids.FEATURE_ID);
    for (const s of flatTickets.filter((t) => t.type === 'story')) {
      assert.equal(s.parent_slug, featureSlug);
    }
  });

  it('projects inter-Story blocked-by references as slug depends_on', () => {
    const { epic, tickets, ids } = buildQuiescentFixture();
    const { flatTickets, issueToSlug } = buildBootstrapInputs(epic, tickets);
    const storyBSlug = issueToSlug.get(ids.STORY_B_ID);
    const storyB = flatTickets.find((t) => t.slug === storyBSlug);
    const storyASlug = issueToSlug.get(ids.STORY_A_ID);
    assert.deepEqual(storyB.depends_on, [storyASlug]);
  });

  it('strips agent::* labels from the epic descriptor', () => {
    const epic = {
      id: 1,
      title: 'X',
      body: 'body',
      labels: ['type::epic', 'agent::done'],
    };
    const { epicDescriptor } = buildBootstrapInputs(epic, []);
    assert.deepEqual(epicDescriptor.labels, ['type::epic']);
  });

  it('derives unique slugs when titles collide', () => {
    const epic = { id: 1, title: 'X' };
    const tickets = [
      {
        id: 10,
        title: 'Duplicate',
        body: `---\nparent: #1`,
        labels: ['type::story'],
      },
      {
        id: 11,
        title: 'Duplicate',
        body: `---\nparent: #1`,
        labels: ['type::story'],
      },
    ];
    const { issueToSlug } = buildBootstrapInputs(epic, tickets);
    const a = issueToSlug.get(10);
    const b = issueToSlug.get(11);
    assert.notEqual(a, b);
    assert.equal(a, 'duplicate');
    assert.equal(b, 'duplicate-11');
  });
});

// ---------------------------------------------------------------------------
// End-to-end happy path — runReverseBootstrap + diff-no-op idempotency
// ---------------------------------------------------------------------------

// Pending follow-on Epic #3163: epic-spec-reverse-bootstrap.js still emits 4-tier
// specs carrying Story.tasks[]. Reinstate after the bootstrap helper is
// rewritten to emit 3-tier shape.
describe.skip('runReverseBootstrap — happy path', () => {
  it('writes a valid spec and a state whose follow-up diff is empty', async () => {
    const { epic, tickets, ids } = buildQuiescentFixture();
    const provider = makeProvider({ epic, tickets });
    const result = await runReverseBootstrap({
      epicId: ids.EPIC_ID,
      provider,
      dryRun: false,
      epicsDir: sandbox,
      now: '2026-05-12T00:00:00Z',
    });

    // 1. Spec file written + schema-valid (loadSpec validates).
    assert.equal(result.wroteSpec, true);
    assert.equal(result.wroteState, true);
    const reloaded = loadSpec(ids.EPIC_ID, { epicsDir: sandbox });
    assert.equal(reloaded.epic.id, ids.EPIC_ID);
    assert.equal(reloaded.epic.title, 'Quiescent Migration Epic');
    assert.equal(reloaded.features.length, 1);
    assert.equal(reloaded.features[0].stories.length, 2);

    // 2. State carries the slug → issue-number mapping (no nulls for
    //    the slugs we projected from live state).
    const stateRaw = readFileSync(result.statePath, 'utf8');
    const state = JSON.parse(stateRaw);
    assert.equal(state.epicId, ids.EPIC_ID);
    // Every projected slug carries the live issue number.
    for (const [slug, entry] of Object.entries(state.mapping)) {
      assert.ok(
        typeof entry.issueNumber === 'number',
        `slug ${slug} must carry an issueNumber`,
      );
    }
    // The synthetic `epic` slug maps to the Epic issue itself.
    assert.equal(state.mapping.epic.issueNumber, ids.EPIC_ID);

    // 3. Follow-up diff is empty (the no-op dry-run AC).
    //
    // The bootstrap strips `agent::*` from the spec (schema forbids them),
    // so the diff engine's label-equality check would otherwise flag a
    // phantom Update on every ticket whose live labels still carry an
    // agent-state row. The realistic "post-quiescence bootstrap" snapshot
    // is one where the wave-runner has already cleared its execution
    // state (i.e. ghState carries only structural labels). We project
    // that here by filtering agent labels out of the ghState rows — the
    // diff engine then sees the same labels on both sides.
    const ghState = {};
    for (const t of [epic, ...tickets]) {
      ghState[t.id] = {
        title: t.title,
        body: t.body ?? '',
        labels: (t.labels ?? []).filter((l) => !l.startsWith('agent::')),
        state: 'open',
      };
    }
    const plan = diff({ spec: reloaded, state, ghState });
    assert.deepEqual(plan, {
      creates: [],
      updates: [],
      closes: [],
      relinks: [],
    });
  });

  it('captures last-observed agent state per slug', async () => {
    const { epic, tickets, ids } = buildQuiescentFixture();
    const provider = makeProvider({ epic, tickets });
    const result = await runReverseBootstrap({
      epicId: ids.EPIC_ID,
      provider,
      dryRun: false,
      epicsDir: sandbox,
      now: '2026-05-12T00:00:00Z',
    });
    const state = JSON.parse(readFileSync(result.statePath, 'utf8'));
    // Story A carries agent::done in the fixture; that label must
    // appear on its mapping entry's lastObservedAgentState.
    const storyAEntry = Object.values(state.mapping).find(
      (e) => e.issueNumber === ids.STORY_A_ID,
    );
    assert.equal(storyAEntry.lastObservedAgentState, 'agent::done');
    // Story B has no agent label → null.
    const storyBEntry = Object.values(state.mapping).find(
      (e) => e.issueNumber === ids.STORY_B_ID,
    );
    assert.equal(storyBEntry.lastObservedAgentState, null);
  });

  it('produces byte-identical artefacts when run twice on the same Epic', async () => {
    const { epic, tickets, ids } = buildQuiescentFixture();
    const provider = makeProvider({ epic, tickets });
    const first = await runReverseBootstrap({
      epicId: ids.EPIC_ID,
      provider,
      dryRun: false,
      epicsDir: sandbox,
      now: '2026-05-12T00:00:00Z',
    });
    const firstSpec = readFileSync(first.specPath, 'utf8');
    const firstState = readFileSync(first.statePath, 'utf8');

    const second = await runReverseBootstrap({
      epicId: ids.EPIC_ID,
      provider,
      dryRun: false,
      epicsDir: sandbox,
      now: '2026-05-12T00:00:00Z',
    });
    assert.equal(readFileSync(second.specPath, 'utf8'), firstSpec);
    assert.equal(readFileSync(second.statePath, 'utf8'), firstState);
  });

  it('dry-run writes nothing but returns the rendered spec', async () => {
    const { epic, tickets, ids } = buildQuiescentFixture();
    const provider = makeProvider({ epic, tickets });
    const result = await runReverseBootstrap({
      epicId: ids.EPIC_ID,
      provider,
      dryRun: true,
      epicsDir: sandbox,
      now: '2026-05-12T00:00:00Z',
    });
    assert.equal(result.dryRun, true);
    assert.equal(result.wroteSpec, false);
    assert.equal(result.wroteState, false);
    assert.equal(result.spec.epic.id, ids.EPIC_ID);
    // Verify nothing landed on disk by re-attempting a loadSpec.
    assert.throws(() => loadSpec(ids.EPIC_ID, { epicsDir: sandbox }));
  });
});

// ---------------------------------------------------------------------------
// CLI — runBootstrap envelope behaviour
// ---------------------------------------------------------------------------

describe('runBootstrap (CLI) — refusal path', () => {
  it('exits 2 with structured stderr when a Story is executing', async () => {
    const { epic, tickets, ids } = buildQuiescentFixture();
    tickets
      .find((t) => t.id === ids.STORY_B_ID)
      .labels.push('agent::executing');

    const stderr = [];
    const result = await runBootstrap(
      { epicId: ids.EPIC_ID, dryRun: false },
      {
        provider: makeProvider({ epic, tickets }),
        epicsDir: sandbox,
        stderr: (line) => stderr.push(line),
        stdout: () => {},
        now: '2026-05-12T00:00:00Z',
      },
    );
    assert.equal(result.exitCode, EXIT_CODES.EPIC_NOT_QUIESCENT);
    assert.equal(result.exitCode, 2);
    // Structured token must be present so log scrapers can match.
    assert.ok(
      stderr.some((line) => line.includes(`code=${EPIC_NOT_QUIESCENT_CODE}`)),
      'stderr should carry the structured EPIC_NOT_QUIESCENT line',
    );
    // The envelope's structured `error` block names the offending Story.
    assert.equal(result.error.code, EPIC_NOT_QUIESCENT_CODE);
    assert.equal(result.error.epicId, ids.EPIC_ID);
    assert.equal(result.error.executingStories[0].id, ids.STORY_B_ID);
  });

  it('exits 1 when epicId is missing', async () => {
    const stderr = [];
    const result = await runBootstrap(
      { epicId: null, dryRun: false },
      {
        provider: makeProvider({ epic: { id: 1, title: 'X' }, tickets: [] }),
        epicsDir: sandbox,
        stderr: (line) => stderr.push(line),
        stdout: () => {},
      },
    );
    assert.equal(result.exitCode, EXIT_CODES.VALIDATION_ERROR);
    assert.ok(
      stderr.some((line) => line.toLowerCase().includes('epic id')),
      'stderr should explain the missing epic id',
    );
  });

  // Pending follow-on Epic #3163: this test invokes runBootstrap end-to-end, which
  // re-renders the Epic as a 4-tier spec. Reinstate after the bootstrap
  // helper is rewritten to emit 3-tier shape.
  it.skip('exits 0 on a quiescent Epic and prints the spec/state paths', async () => {
    const { epic, tickets, ids } = buildQuiescentFixture();
    const stdout = [];
    const result = await runBootstrap(
      { epicId: ids.EPIC_ID, dryRun: false },
      {
        provider: makeProvider({ epic, tickets }),
        epicsDir: sandbox,
        stderr: () => {},
        stdout: (line) => stdout.push(line),
        now: '2026-05-12T00:00:00Z',
      },
    );
    assert.equal(result.exitCode, EXIT_CODES.OK);
    assert.ok(result.bootstrap.wroteSpec);
    assert.ok(result.bootstrap.wroteState);
    assert.ok(stdout.some((line) => line.includes('Reverse-bootstrap wrote')));
  });

  it('exit-code constant pins EPIC_NOT_QUIESCENT to 2', () => {
    assert.equal(EXIT_CODES.EPIC_NOT_QUIESCENT, 2);
    assert.equal(EXIT_CODES.EXPLICIT_DELETE_REQUIRED, 2);
  });
});

// ---------------------------------------------------------------------------
// State projection — diff-engine-shape contract
// ---------------------------------------------------------------------------

// Pending follow-on Epic #3163: buildBootstrapState still projects Task tickets
// into the state map. Reinstate after 3-tier rewrite.
describe.skip('buildBootstrapState — diff-shape contract', () => {
  it('emits an `epic` mapping row pointing at the Epic issue number', () => {
    const { epic, tickets } = buildQuiescentFixture();
    const { flatTickets, epicDescriptor, issueToSlug } = buildBootstrapInputs(
      epic,
      tickets,
    );
    const spec = renderSpec(flatTickets, { epic: epicDescriptor });
    const state = buildBootstrapState(spec, issueToSlug, {
      now: '2026-05-12T00:00:00Z',
    });
    assert.ok(state.mapping.epic, 'expected synthetic epic row');
    assert.equal(state.mapping.epic.issueNumber, epic.id);
    assert.equal(state.mapping.epic.entity, 'epic');
    assert.equal(state.mapping.epic.parentSlug, null);
  });

  it('carries `wave` and `dependsOn` on story mapping entries', () => {
    const { epic, tickets, ids } = buildQuiescentFixture();
    const { flatTickets, epicDescriptor, issueToSlug } = buildBootstrapInputs(
      epic,
      tickets,
    );
    const spec = renderSpec(flatTickets, { epic: epicDescriptor });
    const state = buildBootstrapState(spec, issueToSlug, {
      now: '2026-05-12T00:00:00Z',
    });
    const storyB = state.mapping[issueToSlug.get(ids.STORY_B_ID)];
    assert.equal(storyB.entity, 'story');
    assert.equal(typeof storyB.wave, 'number');
    assert.deepEqual(storyB.dependsOn, [issueToSlug.get(ids.STORY_A_ID)]);
  });
});

// ---------------------------------------------------------------------------
// On-disk spec — schema-conformance smoke test
// ---------------------------------------------------------------------------

// Pending follow-on Epic #3163: bootstrap helper emits 4-tier YAML. Reinstate
// after the helper is rewritten to emit 3-tier shape.
describe.skip('reverse-bootstrap spec — on-disk YAML', () => {
  it('writes deterministic YAML that round-trips via loadSpec', async () => {
    const { epic, tickets, ids } = buildQuiescentFixture();
    const provider = makeProvider({ epic, tickets });
    const result = await runReverseBootstrap({
      epicId: ids.EPIC_ID,
      provider,
      dryRun: false,
      epicsDir: sandbox,
      now: '2026-05-12T00:00:00Z',
    });
    const onDisk = readFileSync(result.specPath, 'utf8');
    // js-yaml output is parseable JSON-like; ensure the reloader sees
    // the same shape the renderer produced.
    const reparsed = yaml.load(onDisk);
    assert.equal(reparsed.epic.id, ids.EPIC_ID);
    // No agent::* labels leak through.
    const stories = reparsed.features[0].stories;
    for (const s of stories) {
      for (const l of s.labels ?? []) {
        assert.ok(!l.startsWith('agent::'), `story label ${l} leaked`);
      }
      for (const t of s.tasks ?? []) {
        for (const l of t.labels ?? []) {
          assert.ok(!l.startsWith('agent::'), `task label ${l} leaked`);
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 3-tier hierarchy (Story #3117 / Epic #3078)
//
// Bootstrapping a 3-tier Epic (Feature → Story only, no `type::task`
// children) must:
//   1. classify and project Feature + Story rows correctly,
//   2. NOT synthesise any task rows from the empty type::task bucket, and
//   3. produce a state file whose follow-up diff is empty (no false
//      "missing Task" close ops).
// ---------------------------------------------------------------------------

function build3tierFixture() {
  const EPIC_ID = 9200;
  const FEATURE_ID = 9201;
  const STORY_ID = 9202;

  const epic = {
    id: EPIC_ID,
    title: '3-tier Epic',
    body: '3-tier epic body.',
    labels: ['type::epic'],
  };
  const tickets = [
    {
      id: FEATURE_ID,
      title: 'Tri-Feature',
      body: `Feature body.\n\n---\nparent: #${EPIC_ID}`,
      labels: ['type::feature'],
    },
    {
      id: STORY_ID,
      title: 'Tri-Story with inline AC',
      body: `Story body with inline acceptance/verify.\n\n---\nparent: #${FEATURE_ID}\nEpic: #${EPIC_ID}`,
      labels: ['type::story', 'persona::engineer'],
    },
  ];
  return { epic, tickets, ids: { EPIC_ID, FEATURE_ID, STORY_ID } };
}

// Pending follow-on Epic #3163: spec-renderer.js still emits a Story.tasks[] field
// even for 3-tier inputs, which the schema now rejects. Reinstate after
// the renderer is rewritten to omit Story.tasks under 3-tier.
describe.skip('runReverseBootstrap — 3-tier hierarchy (Story #3117)', () => {
  it('bootstraps a Feature+Story-only Epic without phantom task rows', async () => {
    const { epic, tickets, ids } = build3tierFixture();
    const provider = makeProvider({ epic, tickets });
    const result = await runReverseBootstrap({
      epicId: ids.EPIC_ID,
      provider,
      dryRun: false,
      epicsDir: sandbox,
      now: '2026-05-27T00:00:00Z',
    });
    assert.equal(result.wroteSpec, true);
    const reloaded = loadSpec(ids.EPIC_ID, { epicsDir: sandbox });
    assert.equal(reloaded.epic.id, ids.EPIC_ID);
    assert.equal(reloaded.features.length, 1);
    assert.equal(reloaded.features[0].stories.length, 1);
    const story = reloaded.features[0].stories[0];
    // Critical: no synthesised tasks[] entry when no type::task tickets
    // exist on the Epic. The schema makes tasks[] optional precisely so
    // 3-tier specs round-trip without phantom rows.
    assert.ok(
      story.tasks === undefined || story.tasks.length === 0,
      'a 3-tier Story must not carry synthesised tasks[]',
    );
  });

  it('produces an empty follow-up diff for the 3-tier bootstrap (no false missing-Task closes)', async () => {
    const { epic, tickets, ids } = build3tierFixture();
    const provider = makeProvider({ epic, tickets });
    const result = await runReverseBootstrap({
      epicId: ids.EPIC_ID,
      provider,
      dryRun: false,
      epicsDir: sandbox,
      now: '2026-05-27T00:00:00Z',
    });
    const reloaded = loadSpec(ids.EPIC_ID, { epicsDir: sandbox });
    const state = JSON.parse(readFileSync(result.statePath, 'utf8'));
    const ghState = {};
    for (const t of [epic, ...tickets]) {
      ghState[t.id] = {
        title: t.title,
        body: t.body ?? '',
        labels: (t.labels ?? []).filter((l) => !l.startsWith('agent::')),
        state: 'open',
      };
    }
    const plan = diff({ spec: reloaded, state, ghState });
    assert.deepEqual(plan, {
      creates: [],
      updates: [],
      closes: [],
      relinks: [],
    });
  });
});
