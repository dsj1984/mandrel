/**
 * AC-3 (Story #4684): a Story body hand-authored following only the
 * story-author system prompt — the deterministic body-format lints stated
 * example-first — passes `plan-persist --dry-run` on the FIRST attempt, with no
 * fail-retry round-trip. The dry-run exercises the same validator / parser /
 * assemble gates a real persist runs, write-free.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { runPlanPersist } from '../../.agents/scripts/lib/orchestration/plan-persist/run-plan-persist.js';

/** Minimal write-capturing provider — dry-run must touch none of it. */
function fakeProvider() {
  const created = [];
  return {
    created,
    async createIssue(args) {
      created.push(args);
      return { id: 9000 + created.length, url: 'https://example.test/x' };
    },
    async updateTicket() {},
    async postComment() {
      return { commentId: 1, id: 1 };
    },
    async getTicket(id) {
      return { id, state: 'open', body: '', labels: [] };
    },
    async listIssuesByLabel() {
      return [];
    },
    async getTicketComments() {
      return [];
    },
  };
}

/**
 * A Story authored exactly as the prompt prescribes: `acceptance[]` / `verify[]`
 * at top level, a `body` string with `## Goal` + object-form `## Changes`
 * bullets + a `reason_to_exist` meta, and the matching body sections omitted so
 * persist syncs them in. Every deterministic lint is satisfied up front.
 */
function promptAuthoredStory() {
  const body = [
    '## Goal',
    'Exchange short-lived JWTs so a session survives a server restart.',
    '',
    '## Spec',
    'Add a token-exchange seam behind the existing auth boundary.',
    '',
    '## Changes',
    '- {"path": "tests/scripts/plan-persist.flat-stories.test.js", "assumption": "refactors-existing"}',
  ].join('\n');

  return {
    slug: 'jwt-exchange',
    type: 'story',
    title: 'Implement JWT token exchange',
    acceptance: ['`npm run validate` exits 0 after the exchange lands'],
    verify: ['npm run validate (validate)'],
    body,
  };
}

describe('AC-3: a prompt-authored Story passes dry-run on the first attempt', () => {
  it('assembles and validates write-free without throwing', async () => {
    const provider = fakeProvider();
    const result = await runPlanPersist({
      provider,
      artifacts: { stories: [promptAuthoredStory()] },
      config: {},
      opts: { dryRun: true, skipCleanup: true },
    });

    assert.equal(result.stories.length, 1);
    // Dry-run never writes: the fake provider's createIssue is untouched.
    assert.equal(provider.created.length, 0);
  });

  it('repairs a bare-path Changes bullet and a tier-less verify entry instead of refusing (Story #5312)', async () => {
    // Same Story, but authored the way the bench evidence captured: a bare-path
    // Changes bullet and a tier-less verify entry. Both used to cost a
    // re-authoring round; now the bullet is repaired by probing base and
    // reported, and the verify entry is simply a command.
    const broken = promptAuthoredStory();
    broken.verify = ['npm run validate'];
    broken.body = broken.body.replace(
      '- {"path": "tests/scripts/plan-persist.flat-stories.test.js", "assumption": "refactors-existing"}',
      '- tests/scripts/plan-persist.flat-stories.test.js',
    );

    const result = await runPlanPersist({
      provider: fakeProvider(),
      artifacts: { stories: [broken] },
      config: {},
      opts: { dryRun: true, skipCleanup: true },
    });
    assert.equal(result.stories.length, 1);
    assert.equal(result.repairs.length, 1);
    assert.equal(
      result.repairs[0].path,
      'tests/scripts/plan-persist.flat-stories.test.js',
    );
    assert.equal(result.repairs[0].assumption, 'refactors-existing');
    assert.ok(
      result.warnings.some((w) => /plain-string bullet/.test(w)),
      'the repair is reported on the warning list',
    );
  });

  it('still refuses a `deletes` naming a path absent at base (Story #5342 control)', async () => {
    // `deletes` stays explicit and stays checked: a bare path can never mean
    // a removal, and a removal of something that is not there is a planning
    // error no probe can repair.
    const broken = promptAuthoredStory();
    broken.body = broken.body.replace(
      '- {"path": "tests/scripts/plan-persist.flat-stories.test.js", "assumption": "refactors-existing"}',
      '- {"path": "tests/scripts/plan-persist.no-such-file.test.js", "assumption": "deletes"}',
    );

    await assert.rejects(
      () =>
        runPlanPersist({
          provider: fakeProvider(),
          artifacts: { stories: [broken] },
          config: {},
          opts: { dryRun: true, skipCleanup: true },
        }),
      /File assumption mismatch/,
    );
  });

  it('persists a Story with an empty verify[], listing it as a warning (Story #5342 AC-4)', async () => {
    const story = promptAuthoredStory();
    story.verify = [];
    story.body = story.body.replace(
      '- {"path": "tests/scripts/plan-persist.flat-stories.test.js", "assumption": "refactors-existing"}',
      '- tests/scripts/plan-persist.flat-stories.test.js',
    );

    const result = await runPlanPersist({
      provider: fakeProvider(),
      artifacts: { stories: [story] },
      config: {},
      opts: { dryRun: true, skipCleanup: true },
    });
    assert.equal(result.stories.length, 1);
    assert.ok(
      result.warnings.some((w) => /lists no verify\[\] entry/.test(w)),
      `the empty verify[] is warned about, not refused: ${result.warnings.join('\n')}`,
    );
  });

  it('refuses a Story with an empty acceptance[] (Story #5342 AC-4 control)', async () => {
    const story = promptAuthoredStory();
    story.acceptance = [];

    await assert.rejects(
      () =>
        runPlanPersist({
          provider: fakeProvider(),
          artifacts: { stories: [story] },
          config: {},
          opts: { dryRun: true, skipCleanup: true },
        }),
      /lack an inline acceptance contract/,
    );
  });

  it('persists acceptance quoting a non-conventional subject prefix (Story #5342 AC-5)', async () => {
    // The subject-prefix validator is gone; the commit-msg hook and
    // normalize-pr-title.js are where a bad subject is actually caught.
    const story = promptAuthoredStory();
    story.acceptance = ["Commit subject begins with 'baseline-refresh:'"];

    const result = await runPlanPersist({
      provider: fakeProvider(),
      artifacts: { stories: [story] },
      config: {},
      opts: { dryRun: true, skipCleanup: true },
    });
    assert.equal(result.stories.length, 1);
  });

  it('still refuses the one Changes shape only the author can resolve (control)', async () => {
    // A bullet with no path-shaped token cannot be salvaged: persist must
    // reject it — proving the dry-run above passes because the format is
    // correct (or repairable), not because the gates are inert.
    const broken = promptAuthoredStory();
    broken.body = broken.body.replace(
      '- {"path": "tests/scripts/plan-persist.flat-stories.test.js", "assumption": "refactors-existing"}',
      '- tidy up the persist tests',
    );

    await assert.rejects(
      () =>
        runPlanPersist({
          provider: fakeProvider(),
          artifacts: { stories: [broken] },
          config: {},
          opts: { dryRun: true, skipCleanup: true },
        }),
      /is prose, not a path/,
    );
  });
});
