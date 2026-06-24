/**
 * task-graph-builder.test.js — Story #4251 (2-tier sub-issues short-circuit).
 *
 * Colocated under the module's `__tests__/` directory per the named
 * `/single-story-deliver` Verify command for this Story and the unit-tier
 * colocation convention in `rules/testing-standards.md`. The broader
 * topological-sort / mode-derivation coverage lives in the sibling suite
 * `tests/lib/story-init/task-graph-builder.test.js`; this file pins the
 * init-side short-circuit contract specifically.
 *
 * Under the 2-tier hierarchy every Story is childless, so a well-formed
 * 2-tier Story (inline acceptance on its body) MUST NOT issue the
 * child-ticket probe. `provider.getSubTickets` is the seam that fires the
 * empty sub-issues GraphQL query plus the never-matching `/search/issues`
 * scan, so the binding assertion is a zero call count.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildTaskGraph } from '../task-graph-builder.js';

const INLINE_ACCEPTANCE_BODY = [
  '# A 2-tier Story',
  '',
  '## Acceptance Criteria',
  '',
  '- [ ] does the thing',
  '- [ ] does the other thing',
  '',
  '## Verify',
  '',
  '- `npm test`',
].join('\n');

const NO_ACCEPTANCE_BODY = [
  '# A legacy Story',
  '',
  'Some prose, no headings.',
].join('\n');

/**
 * Mock provider that records every `getSubTickets` call — the single seam
 * through which the sub-issues GraphQL query and the `/search/issues`
 * fallback are issued. A zero call count proves no such GitHub request.
 */
function makeRecordingProvider(subTickets = []) {
  const calls = { getSubTickets: [] };
  return {
    calls,
    getSubTickets(storyId) {
      calls.getSubTickets.push(storyId);
      return Promise.resolve(subTickets);
    },
  };
}

describe('buildTaskGraph — 2-tier short-circuit (Story #4251)', () => {
  it('returns {sortedTasks:[],mode:"2-tier"} without any child fetch for an inline-acceptance Story', async () => {
    const provider = makeRecordingProvider();

    const result = await buildTaskGraph({
      provider,
      input: { storyId: 4251, storyBody: INLINE_ACCEPTANCE_BODY },
    });

    assert.deepEqual(result, { sortedTasks: [], mode: '2-tier' });
    assert.equal(
      provider.calls.getSubTickets.length,
      0,
      'getSubTickets (sub-issues GraphQL + /search/issues) must not run for a 2-tier Story',
    );
  });

  it('checks hasInlineAcceptance BEFORE fetching children — no fetch even if children would exist', async () => {
    // Hard cutover (Story #4251): inline acceptance is authoritative. The
    // predicate gates the fetch, so a populated provider is never consulted.
    const provider = makeRecordingProvider([{ id: 999, body: '' }]);

    const result = await buildTaskGraph({
      provider,
      input: { storyId: 4251, storyBody: INLINE_ACCEPTANCE_BODY },
    });

    assert.deepEqual(result, { sortedTasks: [], mode: '2-tier' });
    assert.equal(provider.calls.getSubTickets.length, 0);
  });

  it('falls through to the child-enumeration path when the body lacks inline acceptance', async () => {
    const provider = makeRecordingProvider([]);

    const result = await buildTaskGraph({
      provider,
      input: { storyId: 4260, storyBody: NO_ACCEPTANCE_BODY },
    });

    assert.equal(result.mode, '4-tier');
    assert.deepEqual(result.sortedTasks, []);
    assert.deepEqual(
      provider.calls.getSubTickets,
      [4260],
      'legacy / 4-tier path must still consult the provider',
    );
  });
});
