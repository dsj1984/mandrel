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
    '',
    '<!-- meta: {"reason_to_exist": "One coherent JWT-exchange capability (b: isolates the token-exchange cutover)"} -->',
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

  it('is the format that fails when the two mechanical lints are violated (control)', async () => {
    // Same Story, but authored the way the bench evidence captured: a bare-path
    // Changes bullet and a tier-less verify entry. Persist must reject it —
    // proving the dry-run above passes because the format is correct, not
    // because the gates are inert.
    const broken = promptAuthoredStory();
    broken.verify = ['npm run validate'];
    broken.body = broken.body.replace(
      '- {"path": "tests/scripts/plan-persist.flat-stories.test.js", "assumption": "refactors-existing"}',
      '- tests/scripts/plan-persist.flat-stories.test.js',
    );

    await assert.rejects(
      () =>
        runPlanPersist({
          provider: fakeProvider(),
          artifacts: { stories: [broken] },
          config: {},
          opts: { dryRun: true, skipCleanup: true },
        }),
      /Suggested fix/,
    );
  });
});
