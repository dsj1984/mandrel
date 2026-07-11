import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
// Story #1437 Task #1446: the `epic-planner.js` engine was retired; its
// `buildAuthoringContext` / `planEpic` exports were migrated into
// `epic-plan-spec.js`. The test suite name is kept as a historical
// breadcrumb so a reader looking for the original module can still find
// this file. The exercised behaviour is unchanged.
//
// Story #4403: the duplicated `TECH_SPEC_SYSTEM_PROMPT` /
// `ACCEPTANCE_SPEC_SYSTEM_PROMPT` backstop (and the `systemPrompts` field on
// the `--emit-context` envelope) is retired — the `epic-plan-spec-author`
// skill body is the sole home for those prompts.
//
// Story #4314: the PRD artifact class is retired; the Epic body carries its
// `## User Stories` section inline.
//
// Story #4324: the Tech Spec / Acceptance Spec context-ticket classes are
// retired too. `planEpic` creates NO tickets — it folds the authored content
// into marker-delimited managed sections of the Epic body (section-scoped
// writes; see lib/epic-body-sections.js). These tests pin that contract,
// including the sentinel oracle: operator-authored prose outside the managed
// sections survives the persist byte-for-byte.
import {
  buildAuthoringContext,
  planEpic,
  resolveReviewRouting,
} from '../.agents/scripts/epic-plan-spec.js';
import {
  extractEpicSection,
  hasEpicSection,
  upsertEpicSection,
} from '../.agents/scripts/lib/epic-body-sections.js';
import { Logger } from '../.agents/scripts/lib/Logger.js';
import {
  getExistingSections,
  hasAllRequestedSections,
  validatePlanEpicInputs,
} from '../.agents/scripts/lib/orchestration/epic-plan-spec/phases/plan-epic.js';
import { deriveRiskEnvelope } from '../.agents/scripts/lib/orchestration/planning-risk.js';

const TECH_SPEC_CONTENT =
  '## Delivery Slicing\n| Slice | What ships | Independent? |\n| --- | --- | --- |\n| Foundation | core | Yes |';
const ACCEPTANCE_TABLE_CONTENT =
  '## Acceptance Table\n| AC ID | Outcome | Feature File | Scenario | Disposition |\n| --- | --- | --- | --- | --- |\n| AC-1 | x | f | s | new |';

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

  it('exposes pure helpers for section preflight decisions', () => {
    assert.doesNotThrow(() =>
      validatePlanEpicInputs({
        techSpecContent: 'tech',
        acceptanceSpecContent: null,
      }),
    );
    const sectionedBody = upsertEpicSection(
      'Epic prose.',
      'techSpec',
      TECH_SPEC_CONTENT,
    );
    assert.deepEqual(getExistingSections({ body: sectionedBody }), {
      techSpec: true,
      acceptanceTable: false,
    });
    assert.equal(
      hasAllRequestedSections({
        existing: { techSpec: true, acceptanceTable: false },
        wantsAcceptanceSpec: false,
      }),
      true,
    );
    assert.equal(
      hasAllRequestedSections({
        existing: { techSpec: true, acceptanceTable: false },
        wantsAcceptanceSpec: true,
      }),
      false,
    );
  });

  it('aborts early if the Epic body already carries the Tech Spec section', async () => {
    mockProvider.getEpic = async () => ({
      id: 1,
      title: 'Fully Planned Epic',
      body: upsertEpicSection('Epic prose.', 'techSpec', TECH_SPEC_CONTENT),
    });

    await planEpic(1, mockProvider, {
      techSpecContent: TECH_SPEC_CONTENT,
    });

    assert.equal(
      mockProvider.updatedTickets.length,
      0,
      'No body write when the Tech Spec section is already present.',
    );
  });

  it('folds the authored Tech Spec into the Epic body — zero tickets created', async () => {
    const result = await planEpic(1, mockProvider, {
      techSpecContent: TECH_SPEC_CONTENT,
    });

    assert.equal(
      mockProvider.createdTickets.length,
      0,
      'A /plan Epic run creates no context tickets — the Epic is the only issue',
    );
    assert.equal(mockProvider.updatedTickets.length, 1);
    const update = mockProvider.updatedTickets[0];
    assert.equal(update.id, 1);
    assert.equal(
      extractEpicSection(update.mutations.body, 'techSpec'),
      TECH_SPEC_CONTENT,
    );
    assert.ok(
      update.mutations.body.startsWith(
        'This epic covers the v5 architectural overhaul.',
      ),
      'the pre-existing Epic prose leads the body unchanged',
    );
    assert.ok(
      !update.mutations.body.includes('## Planning Artifacts'),
      'the Planning Artifacts checklist is gone',
    );
    assert.equal(
      hasEpicSection(update.mutations.body, 'acceptanceTable'),
      false,
      'No acceptance-table section when not requested',
    );
    assert.deepEqual(result, {
      persisted: true,
      reason: 'persisted',
      techSpecPersisted: true,
      acceptanceTable: 'none',
    });
  });

  it('folds the Acceptance Table into its own managed section of the Epic body', async () => {
    mockProvider.getEpic = async (id) => {
      if (id !== 1) return null;
      return {
        id: 1,
        title: 'Implement V5 Core',
        body: 'User-facing security changes and /plan gate routing.',
        labels: ['epic'],
      };
    };

    const result = await planEpic(1, mockProvider, {
      techSpecContent: TECH_SPEC_CONTENT,
      acceptanceSpecContent: ACCEPTANCE_TABLE_CONTENT,
    });

    assert.equal(
      mockProvider.createdTickets.length,
      0,
      'No context tickets — both specs land as Epic-body sections',
    );
    const update = mockProvider.updatedTickets[0];
    assert.equal(
      extractEpicSection(update.mutations.body, 'techSpec'),
      TECH_SPEC_CONTENT,
    );
    assert.equal(
      extractEpicSection(update.mutations.body, 'acceptanceTable'),
      ACCEPTANCE_TABLE_CONTENT,
    );
    // Canonical order: Tech Spec section before the Acceptance Table.
    assert.ok(
      update.mutations.body.indexOf('mandrel:tech-spec:start') <
        update.mutations.body.indexOf('mandrel:acceptance-table:start'),
    );
    assert.equal(result.acceptanceTable, 'persisted');
  });

  // Story #4324 sentinel oracle (section-scoped writes guardrail): an
  // unrelated operator edit elsewhere in the Epic body survives the spec
  // persist byte-for-byte.
  it('preserves operator prose outside the managed sections (sentinel oracle)', async () => {
    const SENTINEL = 'Operator note SENTINEL-4324 — do not touch.';
    const originalBody = [
      '## Context',
      'Prose.',
      '',
      SENTINEL,
      '',
      '## Acceptance Criteria',
      '- [ ] bullet one',
    ].join('\n');
    mockProvider.getEpic = async () => ({
      id: 1,
      title: 'Sentinel Epic',
      body: originalBody,
      labels: ['epic'],
    });

    await planEpic(1, mockProvider, {
      techSpecContent: TECH_SPEC_CONTENT,
      acceptanceSpecContent: ACCEPTANCE_TABLE_CONTENT,
    });

    const written = mockProvider.updatedTickets[0].mutations.body;
    assert.ok(
      written.startsWith(originalBody),
      'every pre-existing byte (incl. the sentinel) leads the new body unchanged',
    );
    assert.ok(written.includes(SENTINEL));
  });

  it('applies the acceptance::n-a waiver and strips a stale acceptance table', async () => {
    const staleBody = upsertEpicSection(
      upsertEpicSection('Epic prose.', 'techSpec', 'old spec'),
      'acceptanceTable',
      ACCEPTANCE_TABLE_CONTENT,
    );
    mockProvider.getEpic = async () => ({
      id: 1,
      title: 'Waived Epic',
      body: staleBody,
      labels: ['epic'],
    });
    const planningRisk = deriveRiskEnvelope({
      axes: [
        { axis: 'docs-only', level: 'low', rationale: 'docs only change.' },
      ],
      summary: 'Docs only.',
    });
    assert.equal(planningRisk.acceptanceDisposition, 'not-applicable');

    const result = await planEpic(
      1,
      mockProvider,
      { techSpecContent: TECH_SPEC_CONTENT },
      {},
      { force: true, planningRisk },
    );

    assert.equal(result.acceptanceTable, 'waived');
    const update = mockProvider.updatedTickets[0];
    assert.equal(
      hasEpicSection(update.mutations.body, 'acceptanceTable'),
      false,
    );
    assert.deepEqual(update.mutations.labels, { add: ['acceptance::n-a'] });
  });

  it('strips a legacy Planning Artifacts checklist on persist (Story #4019 → #4324)', async () => {
    // A historical Epic body still carries the retired checklist pointing
    // at old context tickets. Persist removes it (legacy links ignored,
    // not fetched) and folds the authored content as sections.
    mockProvider.getEpic = async () => ({
      id: 1,
      title: 'Historical Epic',
      body: 'Epic body.\n\n## Planning Artifacts\n- [ ] Tech Spec: #42\n',
    });

    await planEpic(1, mockProvider, {
      techSpecContent: TECH_SPEC_CONTENT,
    });

    const update = mockProvider.updatedTickets[0];
    assert.ok(update, 'Epic body update expected');
    assert.ok(
      !update.mutations.body.includes('## Planning Artifacts'),
      'the retired checklist is stripped',
    );
    assert.ok(!update.mutations.body.includes('#42'));
    assert.ok(update.mutations.body.startsWith('Epic body.'));
    assert.equal(
      extractEpicSection(update.mutations.body, 'techSpec'),
      TECH_SPEC_CONTENT,
    );
  });

  it('returns persisted:false when all requested sections already exist (Story #4019)', async () => {
    mockProvider.getEpic = async () => ({
      id: 1,
      title: 'Fully Planned Epic',
      body: upsertEpicSection('Epic prose.', 'techSpec', TECH_SPEC_CONTENT),
    });

    const result = await planEpic(1, mockProvider, {
      techSpecContent: TECH_SPEC_CONTENT,
    });

    assert.equal(result.persisted, false);
    assert.equal(result.reason, 'already-planned');
    assert.equal(result.techSpecPersisted, true);
    assert.ok(!('techSpecId' in result), 'result carries no ticket ids');
  });

  it('overwrites the sections in place under force and posts a regeneration audit', async () => {
    const comments = [];
    mockProvider.getEpic = async () => ({
      id: 1,
      title: 'Force Epic',
      body: upsertEpicSection('Epic prose.', 'techSpec', 'stale spec'),
      labels: ['epic'],
    });
    mockProvider.postComment = async (id, comment) => {
      comments.push({ id, comment });
    };

    const result = await planEpic(
      1,
      mockProvider,
      { techSpecContent: TECH_SPEC_CONTENT },
      {},
      { force: true },
    );

    assert.equal(result.persisted, true);
    assert.equal(result.reason, 'force-replan');
    const update = mockProvider.updatedTickets[0];
    assert.equal(
      extractEpicSection(update.mutations.body, 'techSpec'),
      TECH_SPEC_CONTENT,
    );
    assert.equal(comments.length, 1);
    assert.match(comments[0].comment.body, /Regeneration Audit/);
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
  it('returns the epic and docs context', async () => {
    const provider = {
      async getEpic(id) {
        return {
          id,
          title: 'Context Epic',
          body: 'Epic body text.',
        };
      },
    };

    const ctx = await buildAuthoringContext(7, provider, {});

    assert.equal(ctx.epic.id, 7);
    assert.equal(ctx.epic.title, 'Context Epic');
    assert.equal(ctx.epic.body, 'Epic body text.');
    // Story #4324 — no linkedIssues; the envelope reports which managed
    // planning sections the body already carries (re-plan signal).
    assert.ok(!('linkedIssues' in ctx.epic));
    assert.deepEqual(ctx.epic.planningSections, {
      techSpec: false,
      acceptanceTable: false,
    });
    // Story #4403 — the systemPrompts backstop is retired; the
    // `epic-plan-spec-author` skill body is the sole home for the Tech
    // Spec / Acceptance Spec system prompts.
    assert.equal('systemPrompts' in ctx, false);
    // Story #4433 — docsContext is digest-first: a silent no-op (`null`)
    // when `project.docsContextFiles` is unset, as it is in this test's
    // empty `settings`. No embedded doc content / `items[]` shape survives
    // the hard cutover — see the dedicated coverage in
    // `tests/plan-docs-digest.test.js` for the configured-digest path.
    assert.equal(ctx.docsContext, null);
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
