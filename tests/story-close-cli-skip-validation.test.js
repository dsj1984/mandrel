import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseSprintArgs } from '../.agents/scripts/lib/cli-args.js';
import { resolveCloseInputs } from '../.agents/scripts/lib/orchestration/story-close/close-inputs.js';

/**
 * Hard-stub provider matching the slice of `Provider` that `resolveCloseInputs`
 * touches. The Story body carries the `Epic: #N` marker the hierarchy resolver
 * needs to derive `epicId` without an explicit `--epic` flag.
 */
function stubProvider(storyId, epicId = 9999) {
  return {
    async getTicket(id) {
      assert.equal(id, storyId);
      return {
        number: id,
        title: 'fixture story',
        body: `## Goal\n\nfixture\n\nEpic: #${epicId}\n`,
        labels: [{ name: 'type::story' }],
      };
    },
    primeTicketCache() {},
  };
}

describe('story-close CLI — --skip-validation threading', () => {
  it('resolveCloseInputs(skipValidationParam: true) surfaces skipValidation:true', async () => {
    const out = await resolveCloseInputs({
      storyIdParam: 4242,
      epicIdParam: 9999,
      skipValidationParam: true,
      cwdParam: process.cwd(),
      injectedProvider: stubProvider(4242, 9999),
    });
    assert.equal(out.skipValidation, true);
    assert.equal(out.storyId, 4242);
    assert.equal(out.epicId, 9999);
  });

  it('resolveCloseInputs without skipValidationParam defaults to skipValidation:false', async () => {
    const out = await resolveCloseInputs({
      storyIdParam: 4242,
      epicIdParam: 9999,
      cwdParam: process.cwd(),
      injectedProvider: stubProvider(4242, 9999),
    });
    assert.equal(out.skipValidation, false);
  });

  it('parseSprintArgs picks up --skip-validation from argv (CLI surface)', () => {
    const parsed = parseSprintArgs([
      'node',
      'story-close.js',
      '--story',
      '4242',
      '--skip-validation',
      '--cwd',
      '/tmp/fixture',
    ]);
    assert.equal(parsed.storyId, 4242);
    assert.equal(parsed.skipValidation, true);
    assert.equal(parsed.cwd, '/tmp/fixture');
  });

  it('resolveCloseInputs(no params) parses argv and threads --skip-validation', async () => {
    const originalArgv = process.argv;
    process.argv = [
      'node',
      'story-close.js',
      '--story',
      '4242',
      '--epic',
      '9999',
      '--skip-validation',
      '--cwd',
      process.cwd(),
    ];
    try {
      const out = await resolveCloseInputs({
        injectedProvider: stubProvider(4242, 9999),
      });
      assert.equal(out.skipValidation, true);
      assert.equal(out.storyId, 4242);
      assert.equal(out.epicId, 9999);
    } finally {
      process.argv = originalArgv;
    }
  });
});
