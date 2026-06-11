import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
// Story #1437 Task #1446: the `epic-planner.js` engine was retired; its
// `buildAuthoringContext` / `planEpic` / system-prompt exports were
// migrated into `epic-plan-spec.js`. The test suite name is kept as a
// historical breadcrumb so a reader looking for the original module can
// still find this file. The exercised behaviour is unchanged.
import {
  ACCEPTANCE_SPEC_SYSTEM_PROMPT,
  buildAuthoringContext,
  PRD_SYSTEM_PROMPT,
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
          linkedIssues: { prd: null, techSpec: null },
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
          prdContent: 'x',
          techSpecContent: 'y',
        }),
      { message: 'Epic #999 not found.' },
    );
  });

  it('rejects empty PRD content', async () => {
    await assert.rejects(
      async () =>
        await planEpic(1, mockProvider, {
          prdContent: '',
          techSpecContent: 'y',
        }),
      { message: /prdContent is required/ },
    );
  });

  it('rejects empty Tech Spec content', async () => {
    await assert.rejects(
      async () =>
        await planEpic(1, mockProvider, {
          prdContent: 'x',
          techSpecContent: '   ',
        }),
      { message: /techSpecContent is required/ },
    );
  });

  it('rejects empty Acceptance Spec content when supplied', async () => {
    await assert.rejects(
      async () =>
        await planEpic(1, mockProvider, {
          prdContent: 'x',
          techSpecContent: 'y',
          acceptanceSpecContent: '   ',
        }),
      { message: /acceptanceSpecContent, when provided/ },
    );
  });

  it('exposes pure helpers for artifact preflight decisions', () => {
    assert.doesNotThrow(() =>
      validatePlanEpicInputs({
        prdContent: 'prd',
        techSpecContent: 'tech',
        acceptanceSpecContent: null,
      }),
    );
    assert.deepEqual(
      getExistingArtifactIds({
        linkedIssues: { prd: 10, techSpec: 11, acceptanceSpec: 12 },
      }),
      { prd: 10, techSpec: 11, acceptanceSpec: 12 },
    );
    assert.equal(
      hasAllRequestedArtifacts({
        existing: { prd: 10, techSpec: 11, acceptanceSpec: null },
        wantsAcceptanceSpec: false,
      }),
      true,
    );
    assert.equal(
      hasAllRequestedArtifacts({
        existing: { prd: 10, techSpec: 11, acceptanceSpec: null },
        wantsAcceptanceSpec: true,
      }),
      false,
    );
  });

  it('aborts early if epic already has BOTH linked issues', async () => {
    mockProvider.getEpic = async () => ({
      id: 1,
      title: 'Fully Linked Epic',
      body: '',
      linkedIssues: { prd: 42, techSpec: 43 },
    });

    await planEpic(1, mockProvider, {
      prdContent: '## Overview\nx',
      techSpecContent: '## Technical Overview\ny',
    });

    assert.equal(
      mockProvider.createdTickets.length,
      0,
      'No tickets should be created if both already linked.',
    );
  });

  it('resumes from existing PRD when only Tech Spec is missing', async () => {
    mockProvider.getEpic = async () => ({
      id: 1,
      title: 'Partial Epic',
      body: '',
      linkedIssues: { prd: 42, techSpec: null },
    });
    mockProvider.getTicket = async (id) => ({
      id,
      body: '## Overview\nExisting PRD content from ticket #42.',
    });

    await planEpic(1, mockProvider, {
      prdContent: '## Overview\nignored — PRD already exists',
      techSpecContent: '## Technical Overview\nauthored tech spec',
    });

    assert.equal(
      mockProvider.createdTickets.length,
      1,
      'Should create only the Tech Spec.',
    );
    assert.equal(
      mockProvider.createdTickets[0].ticketData.title,
      '[Tech Spec] Partial Epic',
    );
    assert.equal(
      mockProvider.createdTickets[0].ticketData.body,
      '## Technical Overview\nauthored tech spec',
    );
  });

  it('runs the full planning pipeline with authored content', async () => {
    await planEpic(1, mockProvider, {
      prdContent: '## Overview\nAuthored PRD.',
      techSpecContent: '## Technical Overview\nAuthored Tech Spec.',
    });

    assert.equal(
      mockProvider.createdTickets.length,
      2,
      'Should create exactly two tickets',
    );

    const prdCreation = mockProvider.createdTickets[0];
    assert.equal(prdCreation.epicId, 1);
    assert.equal(prdCreation.ticketData.title, '[PRD] Implement V5 Core');
    assert.equal(prdCreation.ticketData.body, '## Overview\nAuthored PRD.');
    assert.deepEqual(prdCreation.ticketData.labels, ['context::prd']);
    assert.deepEqual(prdCreation.ticketData.dependencies, []);

    const tsCreation = mockProvider.createdTickets[1];
    assert.equal(tsCreation.epicId, 1);
    assert.equal(tsCreation.ticketData.title, '[Tech Spec] Implement V5 Core');
    assert.equal(
      tsCreation.ticketData.body,
      '## Technical Overview\nAuthored Tech Spec.',
    );
    assert.deepEqual(tsCreation.ticketData.labels, ['context::tech-spec']);
    assert.deepEqual(tsCreation.ticketData.dependencies, [100]);

    assert.equal(mockProvider.updatedTickets.length, 1);
    const update = mockProvider.updatedTickets[0];
    assert.equal(update.id, 1);
    assert.ok(update.mutations.body.includes('- [ ] PRD: #100'));
    assert.ok(update.mutations.body.includes('- [ ] Tech Spec: #101'));
    assert.ok(
      !update.mutations.body.includes('Acceptance Spec'),
      'No acceptance-spec line when not requested',
    );
  });

  it('creates a third context::acceptance-spec ticket and links it in Planning Artifacts', async () => {
    mockProvider.getEpic = async (id) => {
      if (id !== 1) return null;
      return {
        id: 1,
        title: 'Implement V5 Core',
        body: 'User-facing security changes and /plan gate routing.',
        labels: ['epic'],
        linkedIssues: { prd: null, techSpec: null },
      };
    };

    await planEpic(1, mockProvider, {
      prdContent: '## Overview\nAuthored PRD.',
      techSpecContent: '## Technical Overview\nAuthored Tech Spec.',
      acceptanceSpecContent:
        '## Acceptance Criteria\n| AC-1 | x | f | s | new |',
    });

    assert.equal(
      mockProvider.createdTickets.length,
      3,
      'Should create exactly three tickets',
    );

    const acceptanceCreation = mockProvider.createdTickets[2];
    assert.equal(acceptanceCreation.epicId, 1);
    assert.equal(
      acceptanceCreation.ticketData.title,
      '[Acceptance Spec] Implement V5 Core',
    );
    assert.match(acceptanceCreation.ticketData.body, /^## Acceptance Criteria/);
    assert.deepEqual(acceptanceCreation.ticketData.labels, [
      'context::acceptance-spec',
    ]);
    // Acceptance Spec depends on Tech Spec (ID 101) so it appears after both
    // upstream artifacts in dependency order.
    assert.deepEqual(acceptanceCreation.ticketData.dependencies, [101]);

    const update = mockProvider.updatedTickets[0];
    assert.ok(update.mutations.body.includes('- [ ] PRD: #100'));
    assert.ok(update.mutations.body.includes('- [ ] Tech Spec: #101'));
    assert.ok(
      update.mutations.body.includes('- [ ] Acceptance Spec: #102'),
      'Planning Artifacts must include the acceptance-spec link',
    );
  });

  it('does not duplicate Planning Artifacts on a partial-recovery rerun (Story #4019)', async () => {
    // PRD present, Tech Spec missing — and the Epic body already carries a
    // stale `## Planning Artifacts` section from the earlier partial run.
    mockProvider.getEpic = async () => ({
      id: 1,
      title: 'Partial Epic',
      body: 'Epic body.\n\n## Planning Artifacts\n- [ ] PRD: #42\n',
      linkedIssues: { prd: 42, techSpec: null },
    });
    mockProvider.getTicket = async (id) => ({ id, body: 'PRD body' });

    await planEpic(1, mockProvider, {
      prdContent: '## Overview\nignored',
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
    assert.ok(update.mutations.body.includes('- [ ] PRD: #42'));
    assert.ok(update.mutations.body.includes('- [ ] Tech Spec: #100'));
    assert.ok(update.mutations.body.startsWith('Epic body.'));
  });

  it('returns persisted:false when all artifacts already exist (Story #4019)', async () => {
    mockProvider.getEpic = async () => ({
      id: 1,
      title: 'Fully Linked Epic',
      body: '',
      linkedIssues: { prd: 42, techSpec: 43 },
    });

    const result = await planEpic(1, mockProvider, {
      prdContent: '## Overview\nx',
      techSpecContent: '## Technical Overview\ny',
    });

    assert.equal(result.persisted, false);
    assert.equal(result.reason, 'already-planned');
    assert.equal(result.prdId, 42);
    assert.equal(result.techSpecId, 43);
  });

  it('returns persisted:true when artifacts are created', async () => {
    const result = await planEpic(1, mockProvider, {
      prdContent: '## Overview\nAuthored PRD.',
      techSpecContent: '## Technical Overview\nAuthored Tech Spec.',
    });
    assert.equal(result.persisted, true);
    assert.equal(result.prdId, 100);
    assert.equal(result.techSpecId, 101);
  });

  it('rejects an empty acceptanceSpecContent string when the flag is supplied', async () => {
    await assert.rejects(
      async () =>
        await planEpic(1, mockProvider, {
          prdContent: '## Overview\nx',
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
          linkedIssues: { prd: null, techSpec: null },
        };
      },
    };

    const ctx = await buildAuthoringContext(7, provider, {});

    assert.equal(ctx.epic.id, 7);
    assert.equal(ctx.epic.title, 'Context Epic');
    assert.equal(ctx.epic.body, 'Epic body text.');
    assert.equal(ctx.systemPrompts.prd, PRD_SYSTEM_PROMPT);
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
          linkedIssues: { prd: null, techSpec: null },
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
