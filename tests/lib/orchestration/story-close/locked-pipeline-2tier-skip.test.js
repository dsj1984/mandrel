/**
 * locked-pipeline-2tier-skip.test.js — Story #4251.
 *
 * The story-close locked pipeline must mirror the init-side short-circuit:
 * a well-formed 2-tier Story (inline acceptance on its body) has no
 * children, so `runStoryCloseLocked` must skip the `fetchChildTickets`
 * probe entirely — `provider.getSubTickets` is the seam that fires the
 * empty sub-issues GraphQL query plus the never-matching `/search/issues`
 * scan, so the binding assertion is a zero call count. A body lacking
 * inline acceptance still enumerates children (legacy / Epic callers
 * unchanged).
 *
 * Heavy post-fetch collaborators (`dispatchRecovery`, `runClosePhase`,
 * the phase-timer snapshot) are stubbed via `t.mock.module` so the test
 * stays focused on the child-fetch decision; gates / code-review are
 * skipped via `skipValidationParam: true`.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = path
  .resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')
  .replace(/\\/g, '/');

const url = (rel) => pathToFileURL(path.resolve(REPO_ROOT, rel)).href;

const SUT_URL = url(
  '.agents/scripts/lib/orchestration/story-close/phases/locked-pipeline.js',
);
const RECOVERY_URL = url(
  '.agents/scripts/lib/orchestration/story-close-recovery.js',
);
const CLOSE_PHASE_URL = url(
  '.agents/scripts/lib/orchestration/story-close/phases/close.js',
);
const PHASE_TIMER_STATE_URL = url(
  '.agents/scripts/lib/util/phase-timer-state.js',
);

const INLINE_ACCEPTANCE_BODY = [
  '# A 2-tier Story',
  '',
  '## Acceptance Criteria',
  '',
  '- [ ] does the thing',
  '',
  '## Verify',
  '',
  '- `npm test`',
].join('\n');

const NO_ACCEPTANCE_BODY = [
  '# A legacy Story',
  '',
  'No inline acceptance.',
].join('\n');

function makeRecordingProvider(subTickets = []) {
  const calls = { getSubTickets: [] };
  return {
    calls,
    getSubTickets(storyId) {
      calls.getSubTickets.push(storyId);
      return Promise.resolve(subTickets);
    },
    primeTicketCache() {},
  };
}

/**
 * Stub the post-fetch collaborators and re-import the SUT with a
 * cache-busting query so each test owns its own mocks.
 */
async function loadSut(t) {
  t.mock.module(RECOVERY_URL, {
    namedExports: {
      dispatchRecovery: () => ({
        resumeFromConflict: false,
        resumeFromMerge: false,
        resumeFromPostMerge: false,
      }),
    },
  });
  t.mock.module(CLOSE_PHASE_URL, {
    namedExports: {
      runClosePhase: () => ({ success: true, result: { stubbed: true } }),
    },
  });
  t.mock.module(PHASE_TIMER_STATE_URL, {
    namedExports: {
      loadPhaseTimerState: () => null,
      clearPhaseTimerState: () => {},
    },
  });
  return import(`${SUT_URL}?bust=${Math.random()}`);
}

function makeArgs(provider, body) {
  return {
    cwd: '/repo',
    storyId: 4251,
    epicId: null,
    epicBranch: 'epic/0',
    storyBranch: 'story-4251',
    config: { delivery: { worktreeIsolation: { enabled: false } } },
    skipValidationParam: true,
    resumeFlag: false,
    restartFlag: false,
    provider,
    story: { id: 4251, body, labels: [] },
    progress: () => {},
  };
}

describe('runStoryCloseLocked — 2-tier child-fetch skip (Story #4251)', () => {
  it('skips fetchChildTickets (zero getSubTickets calls) for an inline-acceptance Story', async (t) => {
    const provider = makeRecordingProvider();
    const { runStoryCloseLocked } = await loadSut(t);

    await runStoryCloseLocked(makeArgs(provider, INLINE_ACCEPTANCE_BODY));

    assert.equal(
      provider.calls.getSubTickets.length,
      0,
      'getSubTickets (sub-issues GraphQL + /search/issues) must not run at close for a 2-tier Story',
    );
  });

  it('still enumerates children for a body lacking inline acceptance', async (t) => {
    const provider = makeRecordingProvider([]);
    const { runStoryCloseLocked } = await loadSut(t);

    await runStoryCloseLocked(makeArgs(provider, NO_ACCEPTANCE_BODY));

    assert.deepEqual(
      provider.calls.getSubTickets,
      [4251],
      'legacy / 4-tier close path must still consult the provider',
    );
  });
});
