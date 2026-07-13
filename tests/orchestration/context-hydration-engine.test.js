import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { envelopeToPrompt } from '../../.agents/scripts/lib/orchestration/context-envelope.js';
import {
  extractStorySections,
  hydrateContext,
  stripStorySectionsForTaskInstructions,
} from '../../.agents/scripts/lib/orchestration/context-hydration-engine.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');

class HierarchyProvider {
  constructor(tickets) {
    this.tickets = tickets;
    this.calls = [];
  }

  async getTicket(id) {
    this.calls.push(id);
    const t = this.tickets[id];
    if (!t) throw new Error(`Ticket #${id} not found`);
    return t;
  }
}

const baseTask = {
  id: 200,
  title: 'Child task',
  body: '> Epic: #1\n\nTask body for hydration',
  labels: [],
};

describe('hydrateContext — envelope return shape', () => {
  it('returns a ContextEnvelope; prose matches envelopeToPrompt', async () => {
    const provider = new HierarchyProvider({
      1: {
        id: 1,
        title: 'Epic',
        body: 'Epic Body',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      200: {
        id: 200,
        title: 'Child task',
        body: baseTask.body,
        updatedAt: '2026-01-02T00:00:00.000Z',
      },
    });

    const envelope = await hydrateContext(
      baseTask,
      provider,
      'epic/1',
      'story-1',
      1,
    );

    assert.equal(envelope.schemaVersion, '1');
    assert.equal(envelope.task.id, 200);
    assert.ok(Array.isArray(envelope.sections));
    assert.ok(Array.isArray(envelope.provenance));

    const prompt = envelopeToPrompt(envelope);
    assert.ok(prompt.includes('Task body for hydration'));
    assert.ok(prompt.includes('Epic Body'));
  });

  it('records provenance for the Epic + Story pair only (legacy Tech Spec refs ignored)', async () => {
    // Story #4324 — the hierarchy fetch is Epic + Story only. A historical
    // task body still carrying a `Tech Spec: #5` reference must not
    // resurrect a third fetch: #5 is never requested and never lands in
    // provenance.
    const provider = new HierarchyProvider({
      1: {
        id: 1,
        title: 'Epic',
        body: 'Epic Body',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      9: {
        id: 9,
        title: 'Story',
        body: 'Story Body',
        updatedAt: '2026-01-04T00:00:00.000Z',
      },
      200: {
        id: 200,
        title: 'Child',
        body: '> Epic: #1\n> Tech Spec: #5\n> Story: #9\n\nDo work',
        updatedAt: '2026-01-05T00:00:00.000Z',
      },
    });

    const envelope = await hydrateContext(
      {
        id: 200,
        title: 'Child',
        body: '> Epic: #1\n> Tech Spec: #5\n> Story: #9\n\nDo work',
      },
      provider,
      'epic/1',
      'story-9',
      1,
    );

    assert.equal(envelope.provenance.length, 2);
    for (const snap of envelope.provenance) {
      assert.ok(typeof snap.id === 'number');
      assert.ok(snap.version);
      assert.match(snap.hash, /^[a-f0-9]{12}$/);
      assert.ok(snap.retrievedAt);
    }
    const ids = envelope.provenance.map((p) => p.id).sort((a, b) => a - b);
    assert.deepEqual(ids, [1, 9]);
    assert.ok(
      !provider.calls.includes(5),
      'the legacy Tech Spec ticket must never be fetched',
    );
  });

  it('slices the hydrated Epic body: keeps Goal/User Stories/Delivery Slicing, drops Context/Acceptance Criteria/Acceptance Table', async () => {
    // Story #4340 guardrail (slicing oracle): the Epic body is cut down to
    // only the sections a delivery story agent acts on. Goal / Non-Goals /
    // User Stories / Tech Spec survive; ideation (## Context), the Epic's
    // ## Acceptance Criteria, and the ## Acceptance Table managed region are
    // dropped. Unknown operator sections are preserved (fail-open).
    const epicBody = [
      '## Context',
      'Epic ideation context.',
      '',
      '## Goal',
      'Ship the thing.',
      '',
      '## User Stories',
      '- As a user I want the thing.',
      '',
      '## Acceptance Criteria',
      '- [ ] the thing works',
      '',
      '## Operator Notes',
      'Keep this hand-authored note.',
      '',
      '<!-- mandrel:tech-spec:start -->',
      '',
      '## Delivery Slicing',
      '| Slice | What ships | Independent? |',
      '| --- | --- | --- |',
      '| S1 | the change | yes |',
      '',
      '<!-- mandrel:tech-spec:end -->',
      '',
      '<!-- mandrel:acceptance-table:start -->',
      '',
      '## Acceptance Table',
      '| AC ID | Outcome | Feature File | Scenario | Disposition |',
      '| --- | --- | --- | --- | --- |',
      '| AC-1 | works end to end | tests/features/x.feature | happy | new |',
      '| AC-2 | fails closed | tests/features/x.feature | sad | new |',
      '',
      '<!-- mandrel:acceptance-table:end -->',
    ].join('\n');

    const provider = new HierarchyProvider({
      1: {
        id: 1,
        title: 'Sectioned Epic',
        body: epicBody,
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      600: {
        id: 600,
        title: 'Sectioned Story',
        body: '> Epic: #1\n\nStory narrative.\n\n## Acceptance\n- inline ac\n\n## Verify\n- node --test\n',
        updatedAt: '2026-01-02T00:00:00.000Z',
      },
    });

    const envelope = await hydrateContext(
      {
        id: 600,
        title: 'Sectioned Story',
        body: '> Epic: #1\n\nStory narrative.\n\n## Acceptance\n- inline ac\n\n## Verify\n- node --test\n',
        labels: ['type::story'],
      },
      provider,
      'epic/1',
      'story-600',
      1,
    );

    const hierarchySection = envelope.sections.find(
      (s) => s.name === 'hierarchy',
    );
    assert.ok(hierarchySection, 'hierarchy section must be emitted');
    // KEEP: Goal, User Stories, Delivery Slicing, and the operator section.
    assert.match(hierarchySection.content, /## Goal/);
    assert.match(hierarchySection.content, /Ship the thing\./);
    assert.match(hierarchySection.content, /## User Stories/);
    assert.match(hierarchySection.content, /## Delivery Slicing/);
    assert.match(hierarchySection.content, /## Operator Notes/);
    // DROP: ideation Context, the Epic's Acceptance Criteria, and the
    // Acceptance Table managed region (no AC-ID rows reach the prompt).
    assert.ok(!hierarchySection.content.includes('## Context'));
    assert.ok(!hierarchySection.content.includes('Epic ideation context.'));
    assert.ok(!hierarchySection.content.includes('## Acceptance Criteria'));
    assert.ok(!hierarchySection.content.includes('the thing works'));
    assert.ok(!hierarchySection.content.includes('## Acceptance Table'));
    assert.ok(!/\|\s*AC-\d+\s*\|/.test(hierarchySection.content));

    const prompt = envelopeToPrompt(envelope);
    assert.ok(prompt.includes('## Delivery Slicing'));
    assert.ok(!prompt.includes('## Acceptance Table'));
    assert.ok(
      !/\|\s*AC-\d+\s*\|/.test(prompt),
      'no AC-ID table rows may reach a delivery prompt',
    );
  });
});

describe('extractStorySections — inline Story body parsing (2-tier)', () => {
  it('parses ## Acceptance and ## Verify checklists', () => {
    const body = [
      'Story narrative paragraph.',
      '',
      '## Acceptance',
      '- [ ] Hydrate Story body',
      '- [x] No regression in 4-tier',
      '',
      '## Verify',
      '- node --test foo.test.js',
      '- node --test bar.test.js',
    ].join('\n');
    const out = extractStorySections(body);
    assert.deepEqual(out.acceptance, [
      'Hydrate Story body',
      'No regression in 4-tier',
    ]);
    assert.deepEqual(out.verify, [
      'node --test foo.test.js',
      'node --test bar.test.js',
    ]);
  });

  it('prefers ## Acceptance Criteria over ## Acceptance when both exist', () => {
    const body = [
      '## Acceptance Criteria',
      '- canonical AC item',
      '',
      '## Acceptance',
      '- legacy AC item',
    ].join('\n');
    const out = extractStorySections(body);
    assert.deepEqual(out.acceptance, ['canonical AC item']);
  });

  it('returns empty arrays when sections are absent', () => {
    assert.deepEqual(extractStorySections('only narrative, no headings'), {
      acceptance: [],
      verify: [],
    });
    assert.deepEqual(extractStorySections(''), {
      acceptance: [],
      verify: [],
    });
  });
});

describe('hydrateContext — 2-tier Story body hydration', () => {
  it('emits acceptanceCriteria + verificationCommands sections from Story body when task carries type::story', async () => {
    const provider = new HierarchyProvider({
      1: {
        id: 1,
        title: 'Epic',
        body: 'Epic Body',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      300: {
        id: 300,
        title: 'Story 2-tier',
        body: '> Epic: #1\n\nStory narrative.\n\n## Acceptance\n- [ ] Inline AC #1\n- [ ] Inline AC #2\n\n## Verify\n- node --test tests/foo.test.js\n',
        updatedAt: '2026-01-02T00:00:00.000Z',
      },
    });

    const envelope = await hydrateContext(
      {
        id: 300,
        title: 'Story 2-tier',
        body: '> Epic: #1\n\nStory narrative.\n\n## Acceptance\n- [ ] Inline AC #1\n- [ ] Inline AC #2\n\n## Verify\n- node --test tests/foo.test.js\n',
        labels: ['type::story', 'persona::engineer'],
      },
      provider,
      'epic/1',
      'story-300',
      1,
    );

    const acSection = envelope.sections.find(
      (s) => s.name === 'acceptanceCriteria',
    );
    const verifySection = envelope.sections.find(
      (s) => s.name === 'verificationCommands',
    );
    assert.ok(acSection, 'acceptanceCriteria section must be emitted');
    assert.ok(verifySection, 'verificationCommands section must be emitted');
    assert.match(acSection.content, /Inline AC #1/);
    assert.match(acSection.content, /Inline AC #2/);
    assert.match(verifySection.content, /node --test tests\/foo\.test\.js/);
    assert.equal(acSection.source?.kind, 'ticket');
    assert.equal(acSection.source?.ref, '300');

    const prompt = envelopeToPrompt(envelope);
    assert.ok(prompt.includes('Inline AC #1'));
    assert.ok(prompt.includes('node --test tests/foo.test.js'));
  });

  it('does NOT emit acceptanceCriteria/verificationCommands when task is type::task (4-tier no regression)', async () => {
    const provider = new HierarchyProvider({
      1: {
        id: 1,
        title: 'Epic',
        body: 'Epic Body',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      400: {
        id: 400,
        title: 'Task 4-tier',
        body: '> Epic: #1\n\n## Acceptance\n- [ ] Task AC\n',
        updatedAt: '2026-01-02T00:00:00.000Z',
      },
    });

    const envelope = await hydrateContext(
      {
        id: 400,
        title: 'Task 4-tier',
        body: '> Epic: #1\n\n## Acceptance\n- [ ] Task AC\n',
        labels: ['type::task', 'persona::engineer'],
      },
      provider,
      'epic/1',
      'story-1',
      1,
    );

    assert.ok(
      !envelope.sections.some((s) => s.name === 'acceptanceCriteria'),
      'acceptanceCriteria MUST NOT be emitted for type::task in 4-tier mode',
    );
    assert.ok(
      !envelope.sections.some((s) => s.name === 'verificationCommands'),
      'verificationCommands MUST NOT be emitted for type::task in 4-tier mode',
    );
    // The taskInstructions section still carries the full body (no regression).
    const taskInst = envelope.sections.find(
      (s) => s.name === 'taskInstructions',
    );
    assert.ok(taskInst, 'taskInstructions still emitted in 4-tier');
    assert.match(taskInst.content, /Task AC/);
  });

  it('schema-identical shape: same envelope keys + section field shape between modes', async () => {
    const provider = new HierarchyProvider({
      1: {
        id: 1,
        title: 'Epic',
        body: 'E',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    });
    const storyEnv = await hydrateContext(
      {
        id: 500,
        title: 'S',
        body: '> Epic: #1\n\n## Acceptance\n- ac\n\n## Verify\n- v\n',
        labels: ['type::story'],
      },
      provider,
      'epic/1',
      'story-500',
      1,
    );
    const taskEnv = await hydrateContext(
      {
        id: 501,
        title: 'T',
        body: '> Epic: #1\n\nbody',
        labels: ['type::task'],
      },
      provider,
      'epic/1',
      'story-1',
      1,
    );
    // Top-level keys identical
    assert.deepEqual(Object.keys(storyEnv).sort(), Object.keys(taskEnv).sort());
    // Section field shape identical (name/priority/content/source on every entry)
    const fieldShape = (s) =>
      ['name', 'priority', 'content', 'estimatedTokens'].every((k) => k in s);
    assert.ok(storyEnv.sections.every(fieldShape));
    assert.ok(taskEnv.sections.every(fieldShape));
  });
});

describe('stripStorySectionsForTaskInstructions', () => {
  it('removes ## Acceptance Criteria / ## Acceptance and ## Verify sections', () => {
    const body = [
      'Story narrative paragraph.',
      '',
      '## Acceptance',
      '- do the thing',
      '',
      '## Verify',
      '- node --test foo.test.js',
      '',
      '## Notes',
      'keep me',
    ].join('\n');
    const out = stripStorySectionsForTaskInstructions(body);
    assert.ok(out.includes('Story narrative paragraph.'));
    assert.ok(out.includes('## Notes'));
    assert.ok(out.includes('keep me'));
    assert.ok(!out.includes('## Acceptance'));
    assert.ok(!out.includes('do the thing'));
    assert.ok(!out.includes('## Verify'));
    assert.ok(!out.includes('node --test foo.test.js'));
  });

  it('is a no-op when the sections are absent', () => {
    const body = 'Just narrative, no acceptance or verify headings.';
    assert.equal(stripStorySectionsForTaskInstructions(body), body);
  });

  it('handles empty / non-string input', () => {
    assert.equal(stripStorySectionsForTaskInstructions(''), '');
    assert.equal(stripStorySectionsForTaskInstructions(null), '');
  });

  it('acceptance-only: strips the acceptance headings but preserves ## Verify', () => {
    const body = [
      '## Acceptance',
      '- do the thing',
      '',
      '## Verify',
      'Prose-only verify with no bullets — kept.',
    ].join('\n');
    const out = stripStorySectionsForTaskInstructions(body, {
      acceptance: true,
      verify: false,
    });
    assert.ok(!out.includes('## Acceptance'), 'acceptance heading stripped');
    assert.ok(!out.includes('do the thing'), 'acceptance body stripped');
    assert.ok(out.includes('## Verify'), '## Verify heading preserved');
    assert.ok(
      out.includes('Prose-only verify with no bullets — kept.'),
      'verify prose preserved',
    );
  });

  it('verify-only: strips ## Verify but preserves the acceptance section', () => {
    const body = [
      '## Acceptance',
      'Prose-only acceptance with no bullets — kept.',
      '',
      '## Verify',
      '- node --test foo.test.js',
    ].join('\n');
    const out = stripStorySectionsForTaskInstructions(body, {
      acceptance: false,
      verify: true,
    });
    assert.ok(out.includes('## Acceptance'), '## Acceptance heading preserved');
    assert.ok(
      out.includes('Prose-only acceptance with no bullets — kept.'),
      'acceptance prose preserved',
    );
    assert.ok(!out.includes('## Verify'), 'verify heading stripped');
    assert.ok(!out.includes('node --test foo.test.js'), 'verify body stripped');
  });

  it('neither flag: returns the body unchanged', () => {
    const body = '## Acceptance\n- a\n\n## Verify\n- b';
    assert.equal(
      stripStorySectionsForTaskInstructions(body, {
        acceptance: false,
        verify: false,
      }),
      body,
    );
  });
});

describe('hydrateContext — acceptance/verify de-duplication (dedup on/off)', () => {
  const epicProvider = () =>
    new HierarchyProvider({
      1: {
        id: 1,
        title: 'Epic',
        body: '## Goal\nShip it.',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    });

  it('dedup ON: taskInstructions drops the inline AC/verify sections when the dedicated sections are present', async () => {
    const storyBody = [
      '> Epic: #1',
      '',
      'Story narrative body.',
      '',
      '## Acceptance',
      '- [ ] Inline AC alpha',
      '',
      '## Verify',
      '- node --test tests/alpha.test.js',
    ].join('\n');

    const envelope = await hydrateContext(
      {
        id: 700,
        title: 'Dedup Story',
        body: storyBody,
        labels: ['type::story'],
      },
      epicProvider(),
      'epic/1',
      'story-700',
      1,
    );

    const taskInst = envelope.sections.find(
      (s) => s.name === 'taskInstructions',
    );
    assert.ok(taskInst, 'taskInstructions section must be emitted');
    // The inline AC/verify sections are stripped from taskInstructions…
    assert.ok(!taskInst.content.includes('## Acceptance'));
    assert.ok(!taskInst.content.includes('## Verify'));
    // …but the narrative body survives.
    assert.ok(taskInst.content.includes('Story narrative body.'));
    // The dedicated sections still carry the lists.
    assert.ok(envelope.sections.some((s) => s.name === 'acceptanceCriteria'));
    assert.ok(envelope.sections.some((s) => s.name === 'verificationCommands'));
  });

  it('each acceptance and verify item appears exactly once in the hydrated envelope', async () => {
    const storyBody = [
      '> Epic: #1',
      '',
      'Story narrative body.',
      '',
      '## Acceptance',
      '- [ ] Inline AC alpha',
      '',
      '## Verify',
      '- node --test tests/alpha.test.js',
    ].join('\n');

    const envelope = await hydrateContext(
      {
        id: 701,
        title: 'Dedup Story',
        body: storyBody,
        labels: ['type::story'],
      },
      epicProvider(),
      'epic/1',
      'story-701',
      1,
    );

    const prompt = envelopeToPrompt(envelope);
    const count = (needle) => prompt.split(needle).length - 1;
    assert.equal(
      count('Inline AC alpha'),
      1,
      'AC item must appear exactly once',
    );
    assert.equal(
      count('node --test tests/alpha.test.js'),
      1,
      'verify item must appear exactly once',
    );
  });

  it('dedup OFF: taskInstructions is byte-identical to the full body when no dedicated sections are emitted', async () => {
    // A type::task (4-tier) unit never emits the dedicated sections, so
    // taskInstructions must carry the full body unchanged (no regression).
    const taskBody = '> Epic: #1\n\n## Acceptance\n- [ ] Task AC\n';
    const envelope = await hydrateContext(
      {
        id: 800,
        title: 'Task 4-tier',
        body: taskBody,
        labels: ['type::task'],
      },
      epicProvider(),
      'epic/1',
      'story-1',
      1,
    );
    const taskInst = envelope.sections.find(
      (s) => s.name === 'taskInstructions',
    );
    assert.ok(taskInst, 'taskInstructions section must be emitted');
    assert.equal(
      taskInst.content,
      `## Task Instructions (Issue #800: Task 4-tier)\n\n${taskBody}`,
      'taskInstructions must be byte-identical to today when dedup is off',
    );
  });

  it('dedup OFF: a type::story with no inline AC/verify keeps the full body in taskInstructions', async () => {
    const storyBody = '> Epic: #1\n\nJust a narrative, no AC or verify.';
    const envelope = await hydrateContext(
      {
        id: 801,
        title: 'Bare Story',
        body: storyBody,
        labels: ['type::story'],
      },
      epicProvider(),
      'epic/1',
      'story-801',
      1,
    );
    const taskInst = envelope.sections.find(
      (s) => s.name === 'taskInstructions',
    );
    assert.equal(
      taskInst.content,
      `## Task Instructions (Issue #801: Bare Story)\n\n${storyBody}`,
    );
  });

  it('asymmetric: a bulletless ## Verify (no dedicated section) is NOT stripped when only acceptance fired', async () => {
    // Acceptance carries bullets (dedicated section fires); Verify carries
    // only prose (no bullets → no verificationCommands section). The old
    // single-flag guard would strip ## Verify anyway, dropping content that
    // nothing else in the envelope reproduces. It must be preserved.
    const storyBody = [
      '> Epic: #1',
      '',
      'Story narrative body.',
      '',
      '## Acceptance',
      '- [ ] Inline AC alpha',
      '',
      '## Verify',
      'Manual verification prose — no bullets here.',
    ].join('\n');

    const envelope = await hydrateContext(
      {
        id: 810,
        title: 'Asymmetric Story',
        body: storyBody,
        labels: ['type::story'],
      },
      epicProvider(),
      'epic/1',
      'story-810',
      1,
    );

    const taskInst = envelope.sections.find(
      (s) => s.name === 'taskInstructions',
    );
    assert.ok(taskInst, 'taskInstructions section must be emitted');
    // Acceptance was reproduced in its dedicated section, so it is stripped…
    assert.ok(!taskInst.content.includes('Inline AC alpha'));
    // …but the bulletless ## Verify has no dedicated twin and MUST survive.
    assert.ok(taskInst.content.includes('## Verify'), '## Verify preserved');
    assert.ok(
      taskInst.content.includes('Manual verification prose — no bullets here.'),
      'verify prose preserved',
    );
    assert.ok(envelope.sections.some((s) => s.name === 'acceptanceCriteria'));
    assert.ok(
      !envelope.sections.some((s) => s.name === 'verificationCommands'),
      'no verificationCommands section for a bulletless Verify',
    );
  });

  it('asymmetric: a bulletless ## Acceptance (no dedicated section) is NOT stripped when only verify fired', async () => {
    const storyBody = [
      '> Epic: #1',
      '',
      'Story narrative body.',
      '',
      '## Acceptance',
      'Prose-only acceptance — no bullets here.',
      '',
      '## Verify',
      '- node --test tests/beta.test.js',
    ].join('\n');

    const envelope = await hydrateContext(
      {
        id: 811,
        title: 'Asymmetric Story',
        body: storyBody,
        labels: ['type::story'],
      },
      epicProvider(),
      'epic/1',
      'story-811',
      1,
    );

    const taskInst = envelope.sections.find(
      (s) => s.name === 'taskInstructions',
    );
    assert.ok(taskInst, 'taskInstructions section must be emitted');
    // Verify was reproduced in its dedicated section, so it is stripped…
    assert.ok(!taskInst.content.includes('node --test tests/beta.test.js'));
    // …but the bulletless ## Acceptance has no dedicated twin and MUST survive.
    assert.ok(
      taskInst.content.includes('## Acceptance'),
      '## Acceptance preserved',
    );
    assert.ok(
      taskInst.content.includes('Prose-only acceptance — no bullets here.'),
      'acceptance prose preserved',
    );
    assert.ok(envelope.sections.some((s) => s.name === 'verificationCommands'));
    assert.ok(
      !envelope.sections.some((s) => s.name === 'acceptanceCriteria'),
      'no acceptanceCriteria section for a bulletless Acceptance',
    );
  });
});
