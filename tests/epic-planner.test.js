import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
// Story #1437 Task #1446: the `epic-planner.js` engine was retired; its
// `buildAuthoringContext` / `planEpic` / system-prompt exports were
// migrated into `epic-plan-spec.js`. The test suite name is kept as a
// historical breadcrumb so a reader looking for the original module can
// still find this file. The exercised behaviour is unchanged.
//
// Story #4314: the PRD artifact class is retired. `planEpic` no longer takes
// `prdContent` and no longer creates a `context::prd` ticket; the Epic body
// carries its `## User Stories` section inline. The Tech Spec is now the first
// artifact `planEpic` creates.
import {
  ACCEPTANCE_SPEC_SYSTEM_PROMPT,
  buildAuthoringContext,
  planEpic,
  resolveReviewRouting,
  TECH_SPEC_SYSTEM_PROMPT,
} from '../.agents/scripts/epic-plan-spec.js';
import { Logger } from '../.agents/scripts/lib/Logger.js';
import {
  getExistingArtifactIds,
  hasAllRequestedArtifacts,
  validatePlanEpicInputs,
} from '../.agents/scripts/lib/orchestration/epic-plan-spec/phases/plan-epic.js';
import { deriveRiskEnvelope } from '../.agents/scripts/lib/orchestration/planning-risk.js';

describe('epic-planner orchestration (v5.6+)', () => {
  let mockProvider;

  beforeEach(() => {
    mockProvider = {
      epicId: 1,
      createdTickets: [],
      updatedTickets: [],

      async getEpic(id) {
        if (id !== 1) return null;
        return {
          id: 1,
          title: 'Implement V5 Core',
          body: 'This epic covers the v5 architectural overhaul.',
          labels: ['epic'],
          linkedIssues: { techSpec: null },
        };
      },

      async createTicket(epicId, ticketData) {
        const newId = 100 + this.createdTickets.length;
        this.createdTickets.push({ epicId, ticketData, newId });
        return { id: newId, url: `https://github.com/test/${newId}` };
      },

      async updateTicket(id, mutations) {
        this.updatedTickets.push({ id, mutations });
      },

      async getTickets(_epicId, _opts) {
        return [];
      },

      async postComment(_id, _comment) {},

      primeTicketCache(_tickets) {},
    };
  });

  it('aborts early if epic cannot be found', async () => {
    await assert.rejects(
      async () =>
        await planEpic(999, mockProvider, {
          techSpecContent: 'y',
        }),
      { message: 'Epic #999 not found.' },
    );
  });

  it('rejects empty Tech Spec content', async () => {
    await assert.rejects(
      async () =>
        await planEpic(1, mockProvider, {
          techSpecContent: '   ',
        }),
      { message: /techSpecContent is required/ },
    );
  });

  it('rejects empty Acceptance Spec content when supplied', async () => {
    await assert.rejects(
      async () =>
        await planEpic(1, mockProvider, {
          techSpecContent: 'y',
          acceptanceSpecContent: '   ',
        }),
      { message: /acceptanceSpecContent, when provided/ },
    );
  });

  it('exposes pure helpers for artifact preflight decisions', () => {
    assert.doesNotThrow(() =>
      validatePlanEpicInputs({
        techSpecContent: 'tech',
        acceptanceSpecContent: null,
      }),
    );
    assert.deepEqual(
      getExistingArtifactIds({
        linkedIssues: { techSpec: 11, acceptanceSpec: 12 },
      }),
      { techSpec: 11, acceptanceSpec: 12 },
    );
    assert.equal(
      hasAllRequestedArtifacts({
        existing: { techSpec: 11, acceptanceSpec: null },
        wantsAcceptanceSpec: false,
      }),
      true,
    );
    assert.equal(
      hasAllRequestedArtifacts({
        existing: { techSpec: 11, acceptanceSpec: null },
        wantsAcceptanceSpec: true,
      }),
      false,
    );
  });

  it('aborts early if epic already has the linked Tech Spec', async () => {
    mockProvider.getEpic = async () => ({
      id: 1,
      title: 'Fully Linked Epic',
      body: '',
      linkedIssues: { techSpec: 43 },
    });

    await planEpic(1, mockProvider, {
      techSpecContent: '## Technical Overview\ny',
    });

    assert.equal(
      mockProvider.createdTickets.length,
      0,
      'No tickets should be created if the Tech Spec is already linked.',
    );
  });

  it('runs the full planning pipeline with authored content', async () => {
    await planEpic(1, mockProvider, {
      techSpecContent: '## Technical Overview\nAuthored Tech Spec.',
    });

    assert.equal(
      mockProvider.createdTickets.length,
      1,
      'Should create exactly one ticket (the Tech Spec)',
    );

    const tsCreation = mockProvider.createdTickets[0];
    assert.equal(tsCreation.epicId, 1);
    assert.equal(tsCreation.ticketData.title, '[Tech Spec] Implement V5 Core');
    assert.equal(
      tsCreation.ticketData.body,
      '## Technical Overview\nAuthored Tech Spec.',
    );
    assert.deepEqual(tsCreation.ticketData.labels, ['context::tech-spec']);
    assert.deepEqual(tsCreation.ticketData.dependencies, []);

    assert.equal(mockProvider.updatedTickets.length, 1);
    const update = mockProvider.updatedTickets[0];
    assert.equal(update.id, 1);
    assert.ok(
      !update.mutations.body.includes('PRD'),
      'No PRD line in Planning Artifacts',
    );
    assert.ok(update.mutations.body.includes('- [ ] Tech Spec: #100'));
    assert.ok(
      !update.mutations.body.includes('Acceptance Spec'),
      'No acceptance-spec line when not requested',
    );
  });

  it('creates a context::acceptance-spec ticket and links it in Planning Artifacts', async () => {
    mockProvider.getEpic = async (id) => {
      if (id !== 1) return null;
      return {
        id: 1,
        title: 'Implement V5 Core',
        body: 'User-facing security changes and /plan gate routing.',
        labels: ['epic'],
        linkedIssues: { techSpec: null },
      };
    };

    await planEpic(1, mockProvider, {
      techSpecContent: '## Technical Overview\nAuthored Tech Spec.',
      acceptanceSpecContent:
        '## Acceptance Criteria\n| AC-1 | x | f | s | new |',
    });

    assert.equal(
      mockProvider.createdTickets.length,
      2,
      'Should create exactly two tickets (Tech Spec + Acceptance Spec)',
    );

    const acceptanceCreation = mockProvider.createdTickets[1];
    assert.equal(acceptanceCreation.epicId, 1);
    assert.equal(
      acceptanceCreation.ticketData.title,
      '[Acceptance Spec] Implement V5 Core',
    );
    assert.match(acceptanceCreation.ticketData.body, /^## Acceptance Criteria/);
    assert.deepEqual(acceptanceCreation.ticketData.labels, [
      'context::acceptance-spec',
    ]);
    // Acceptance Spec depends on Tech Spec (ID 100, the first-created ticket).
    assert.deepEqual(acceptanceCreation.ticketData.dependencies, [100]);

    const update = mockProvider.updatedTickets[0];
    assert.ok(update.mutations.body.includes('- [ ] Tech Spec: #100'));
    assert.ok(
      update.mutations.body.includes('- [ ] Acceptance Spec: #101'),
      'Planning Artifacts must include the acceptance-spec link',
    );
  });

  it('does not duplicate Planning Artifacts on a partial-recovery rerun (Story #4019)', async () => {
    // Tech Spec missing — and the Epic body already carries a stale
    // `## Planning Artifacts` section from an earlier partial run.
    mockProvider.getEpic = async () => ({
      id: 1,
      title: 'Partial Epic',
      body: 'Epic body.\n\n## Planning Artifacts\n- [ ] Tech Spec: #42\n',
      linkedIssues: { techSpec: null },
    });
    mockProvider.getTicket = async (id) => ({ id, body: 'Tech Spec body' });

    await planEpic(1, mockProvider, {
      techSpecContent: '## Technical Overview\nauthored tech spec',
    });

    const update = mockProvider.updatedTickets.find((u) =>
      u.mutations?.body?.includes('## Planning Artifacts'),
    );
    assert.ok(update, 'Epic body update expected');
    const sections =
      update.mutations.body.match(/## Planning Artifacts/g) ?? [];
    assert.equal(
      sections.length,
      1,
      'rerun must not stack a duplicate Planning Artifacts section',
    );
    assert.ok(update.mutations.body.includes('- [ ] Tech Spec: #100'));
    assert.ok(update.mutations.body.startsWith('Epic body.'));
  });

  it('returns persisted:false when all artifacts already exist (Story #4019)', async () => {
    mockProvider.getEpic = async () => ({
      id: 1,
      title: 'Fully Linked Epic',
      body: '',
      linkedIssues: { techSpec: 43 },
    });

    const result = await planEpic(1, mockProvider, {
      techSpecContent: '## Technical Overview\ny',
    });

    assert.equal(result.persisted, false);
    assert.equal(result.reason, 'already-planned');
    assert.equal(result.techSpecId, 43);
    assert.ok(!('prdId' in result), 'result must not carry a prdId');
  });

  it('returns persisted:true when artifacts are created', async () => {
    const result = await planEpic(1, mockProvider, {
      techSpecContent: '## Technical Overview\nAuthored Tech Spec.',
    });
    assert.equal(result.persisted, true);
    assert.equal(result.techSpecId, 100);
    assert.ok(!('prdId' in result), 'result must not carry a prdId');
  });

  it('rejects an empty acceptanceSpecContent string when the flag is supplied', async () => {
    await assert.rejects(
      async () =>
        await planEpic(1, mockProvider, {
          techSpecContent: '## Technical Overview\ny',
          acceptanceSpecContent: '   ',
        }),
      { message: /acceptanceSpecContent.*non-empty/ },
    );
  });
});

describe('epic-planner buildAuthoringContext', () => {
  it('returns the epic, docs context, and system prompts', async () => {
    const provider = {
      async getEpic(id) {
        return {
          id,
          title: 'Context Epic',
          body: 'Epic body text.',
          linkedIssues: { techSpec: null },
        };
      },
    };

    const ctx = await buildAuthoringContext(7, provider, {});

    assert.equal(ctx.epic.id, 7);
    assert.equal(ctx.epic.title, 'Context Epic');
    assert.equal(ctx.epic.body, 'Epic body text.');
    assert.ok(
      !('prd' in ctx.systemPrompts),
      'systemPrompts must not carry a prd key',
    );
    assert.equal(ctx.systemPrompts.techSpec, TECH_SPEC_SYSTEM_PROMPT);
    assert.equal(
      ctx.systemPrompts.acceptanceSpec,
      ACCEPTANCE_SPEC_SYSTEM_PROMPT,
    );
    assert.equal(typeof ctx.systemPrompts.acceptanceSpec, 'string');
    assert.ok(
      ctx.systemPrompts.acceptanceSpec.length > 0,
      'acceptanceSpec system prompt must be non-empty',
    );
    // docsContext is the planning-context budget envelope (Epic #817 Story 9)
    assert.equal(typeof ctx.docsContext, 'object');
    assert.ok(ctx.docsContext);
    assert.ok(['full', 'summary'].includes(ctx.docsContext.mode));
    assert.ok(Array.isArray(ctx.docsContext.items));
    // Story #2094 Task #2103 — bddRunner is verified at planner-context
    // build time so the acceptance-spec body can decide between features-
    // first and dependencies-first ordering.
    assert.equal(typeof ctx.bddRunner, 'object');
    assert.ok(ctx.bddRunner);
    assert.equal(typeof ctx.bddRunner.supported, 'boolean');
    assert.equal(typeof ctx.bddRunner.fallback, 'boolean');
    // Exactly one of supported/fallback is true.
    assert.notEqual(ctx.bddRunner.supported, ctx.bddRunner.fallback);
    assert.equal(typeof ctx.memoryFreshness, 'object');
    assert.equal(typeof ctx.priorFeedback, 'object');
    assert.ok(Array.isArray(ctx.bddScenarios));
    // Epic #3865 — risk is no longer classified at emit-context time; the
    // epic-plan-spec-author Skill authors the verdict as the fourth
    // artifact, so the envelope must not carry a planningRisk field.
    assert.equal('planningRisk' in ctx, false);
  });

  it('branches review routing on planningRisk for low-risk docs-only verdicts', () => {
    const planningRisk = deriveRiskEnvelope({
      axes: [
        {
          axis: 'docs-only',
          level: 'low',
          rationale: 'Documentation-only prose cleanup.',
        },
      ],
      summary: 'Docs-only cleanup.',
    });
    const routing = resolveReviewRouting({ planningRisk });

    assert.equal(planningRisk.gateDecision, 'auto-proceed');
    assert.equal(routing.requiresStop, false);
    assert.equal(routing.decision, 'auto-proceed');
  });

  it('throws when the epic is not found', async () => {
    const provider = {
      async getEpic() {
        return null;
      },
    };
    await assert.rejects(
      async () => await buildAuthoringContext(404, provider, {}),
      { message: 'Epic #404 not found.' },
    );
  });

  // Story #3959 — when the skinny-tier codebase snapshot truncates the file
  // list, the authoring-context phase must surface an operator-visible
  // warning naming the dropped file count and the two remedies (medium tier
  // / narrower include). This repo's own include set exceeds the 250-file
  // skinny cap, so building the context against it reliably truncates.
  it('emits an operator-visible warning when the codebase snapshot truncates', async () => {
    const provider = {
      async getEpic(id) {
        return {
          id,
          title: 'Trunc Epic',
          body: 'Epic body.',
          linkedIssues: { techSpec: null },
        };
      },
    };

    const warnings = [];
    const originalWarn = Logger.warn;
    Logger.warn = (msg) => {
      warnings.push(String(msg));
    };
    try {
      const ctx = await buildAuthoringContext(8, provider, {});
      assert.ok(ctx.codebaseSnapshot, 'expected a codebase snapshot');
      assert.equal(
        ctx.codebaseSnapshot.truncated,
        true,
        'expected this repo snapshot to truncate at the skinny cap',
      );
    } finally {
      Logger.warn = originalWarn;
    }

    const truncWarn = warnings.find((w) =>
      /codebase snapshot truncated/.test(w),
    );
    assert.ok(
      truncWarn,
      `expected a truncation warning, got: ${warnings.join(' | ')}`,
    );
    // Names the dropped count and both documented remedies.
    assert.match(truncWarn, /\d+ of \d+ matched file\(s\) dropped/);
    assert.match(truncWarn, /tier:\s*"medium"/);
    assert.match(truncWarn, /include/);
  });
});
