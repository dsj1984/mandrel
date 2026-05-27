/**
 * tests/contract/finalize/sanitize-skip-ci.test.js
 *
 * Contract test for `sanitizeSkipCiMarkers` and the PR-body assembly
 * path inside `openOrLocatePr` — Story #3165.
 *
 * Asserts:
 *   1. The exported `SKIP_CI_PATTERNS` matches every GitHub-recognised
 *      bracketed marker spelling (`[skip ci]`, `[ci skip]`, `[no ci]`,
 *      `[skip actions]`, `[actions skip]`) — case-insensitive, with
 *      optional inner whitespace — and ONLY the bracketed forms (bare
 *      `skip ci` is left alone because GitHub does not honour it).
 *   2. The sanitizer is idempotent.
 *   3. The body passed by `openOrLocatePr` to `gh pr create` is stripped
 *      of all marker variants, even when the caller supplies a body
 *      whose every line carries `[skip ci]`.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { openOrLocatePr } from '../../../.agents/scripts/lib/orchestration/finalize/open-or-locate-pr.js';
import {
  SKIP_CI_PATTERNS,
  sanitizeSkipCiMarkers,
} from '../../../.agents/scripts/lib/orchestration/finalize/sanitize-skip-ci.js';

const MARKER_VARIANTS = [
  '[skip ci]',
  '[ci skip]',
  '[no ci]',
  '[skip actions]',
  '[actions skip]',
  '[SKIP CI]',
  '[Ci Skip]',
  '[skip  ci]',
  '[ skip ci ]',
];

describe('SKIP_CI_PATTERNS', () => {
  it('matches every documented bracketed marker variant', () => {
    for (const variant of MARKER_VARIANTS) {
      const matched = SKIP_CI_PATTERNS.some((p) => {
        // Reset lastIndex for /g regexes between samples.
        p.lastIndex = 0;
        return p.test(variant);
      });
      assert.equal(matched, true, `expected match for ${variant}`);
    }
  });

  it('does not match bare (un-bracketed) marker text', () => {
    const bareForms = ['skip ci', 'ci skip', 'no ci', 'skipping ci checks'];
    for (const bare of bareForms) {
      const matched = SKIP_CI_PATTERNS.some((p) => {
        p.lastIndex = 0;
        return p.test(bare);
      });
      assert.equal(matched, false, `expected NO match for ${bare}`);
    }
  });

  it('exposes a frozen pattern list', () => {
    assert.equal(Object.isFrozen(SKIP_CI_PATTERNS), true);
  });
});

describe('sanitizeSkipCiMarkers', () => {
  it('strips every marker variant from a multi-line body', () => {
    const input = [
      'feat(orchestration): add Wave-N runner',
      '',
      '[skip ci]',
      'Refactors the wave loop. [ci skip]',
      'See [skip actions] and [actions skip] and [no ci].',
      'BREAKING CHANGE: dispatch manifest schema bumped to v4.',
    ].join('\n');
    const out = sanitizeSkipCiMarkers(input);
    for (const variant of [
      '[skip ci]',
      '[ci skip]',
      '[no ci]',
      '[skip actions]',
      '[actions skip]',
    ]) {
      assert.equal(
        out.toLowerCase().includes(variant.toLowerCase()),
        false,
        `expected ${variant} to be stripped`,
      );
    }
    // Preserves the BREAKING CHANGE footer — release-please relies on
    // it to detect breaking changes in the squash body.
    assert.match(out, /BREAKING CHANGE:/);
  });

  it('is idempotent', () => {
    const input = 'feat: x\n\n[skip ci]\n[ci skip] body line';
    const once = sanitizeSkipCiMarkers(input);
    const twice = sanitizeSkipCiMarkers(once);
    assert.equal(once, twice);
  });

  it('returns non-string input unchanged', () => {
    assert.equal(sanitizeSkipCiMarkers(null), null);
    assert.equal(sanitizeSkipCiMarkers(undefined), undefined);
    assert.equal(sanitizeSkipCiMarkers(42), 42);
  });

  it('leaves a marker-free body untouched apart from trailing-ws collapse', () => {
    const input = 'Closes #123';
    assert.equal(sanitizeSkipCiMarkers(input), 'Closes #123');
  });
});

describe('openOrLocatePr — body sanitization', () => {
  /**
   * Scripted gh spawn — captures every call's args so the test can
   * assert on the `--body` value handed to `gh pr create`.
   */
  function scriptedGh(queue) {
    const calls = [];
    return {
      spawn: ({ args }) => {
        calls.push(args);
        if (queue.length === 0) {
          throw new Error(`unexpected gh call: ${args.join(' ')}`);
        }
        return queue.shift();
      },
      calls,
    };
  }

  it('strips skip-ci markers from a caller-supplied body before gh pr create', async () => {
    const dirtyBody = [
      'Closes #999',
      '',
      '[skip ci]',
      'Body content carried through from a Story commit. [ci skip]',
      'Final line. [no ci] [skip actions] [actions skip]',
    ].join('\n');
    const { spawn, calls } = scriptedGh([
      // 1. gh pr list — no existing PR.
      { status: 0, stdout: '', stderr: '' },
      // 2. gh pr create — returns the html_url.
      {
        status: 0,
        stdout: 'https://github.com/o/r/pull/42\n',
        stderr: '',
      },
      // 3. gh pr view — canonical envelope.
      {
        status: 0,
        stdout: '{"number":42,"url":"https://github.com/o/r/pull/42"}',
        stderr: '',
      },
    ]);

    const result = await openOrLocatePr({
      epicId: 999,
      headBranch: 'epic/999',
      baseBranch: 'main',
      body: dirtyBody,
      ghSpawn: spawn,
    });

    assert.deepEqual(result, {
      prNumber: 42,
      url: 'https://github.com/o/r/pull/42',
      created: true,
    });

    // The second call is `gh pr create` — pull out its `--body` value.
    const createCall = calls[1];
    assert.equal(createCall[0], 'pr');
    assert.equal(createCall[1], 'create');
    const bodyIdx = createCall.indexOf('--body');
    assert.notEqual(bodyIdx, -1, 'gh pr create must carry a --body arg');
    const submittedBody = createCall[bodyIdx + 1];

    for (const marker of [
      '[skip ci]',
      '[ci skip]',
      '[no ci]',
      '[skip actions]',
      '[actions skip]',
    ]) {
      assert.equal(
        submittedBody.toLowerCase().includes(marker.toLowerCase()),
        false,
        `expected ${marker} to be absent from gh pr create --body`,
      );
    }
    // Content surrounding the markers survives.
    assert.match(submittedBody, /Closes #999/);
    assert.match(submittedBody, /Body content carried through/);
  });

  it('default body (Closes #<epicId>) survives sanitization unchanged', async () => {
    const { spawn, calls } = scriptedGh([
      { status: 0, stdout: '', stderr: '' },
      {
        status: 0,
        stdout: 'https://github.com/o/r/pull/7\n',
        stderr: '',
      },
      {
        status: 0,
        stdout: '{"number":7,"url":"https://github.com/o/r/pull/7"}',
        stderr: '',
      },
    ]);

    await openOrLocatePr({
      epicId: 7,
      headBranch: 'epic/7',
      baseBranch: 'main',
      ghSpawn: spawn,
    });

    const createCall = calls[1];
    const bodyIdx = createCall.indexOf('--body');
    assert.equal(createCall[bodyIdx + 1], 'Closes #7');
  });
});
