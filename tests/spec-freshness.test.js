import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';

import { runSpecFreshnessCheck } from '../.agents/scripts/epic-plan-spec.js';
import {
  renderSpecFreshnessComment,
  validateSpecFreshness,
} from '../.agents/scripts/lib/orchestration/spec-freshness.js';

/**
 * Story #2635 — Phase 7 Tech Spec freshness check.
 *
 * The validator scans an authored Tech Spec body for path-shaped
 * references, probes each against `baseBranchRef`, and buckets results
 * into `stale | fresh | ambiguous`. The runner (runSpecFreshnessCheck)
 * persists a JSON report and conditionally upserts a structured comment.
 * Both surfaces are advisory — neither throws on probe failure or
 * provider errors, so Phase 7 stays non-blocking.
 */

describe('validateSpecFreshness — path extraction and bucketing', () => {
  it('returns all-fresh when every cited path exists at base ref', () => {
    const body = [
      '## Tech Spec',
      '',
      'The work refactors `src/auth.ts` and updates `lib/handlers/login.ts`.',
      'No new modules.',
    ].join('\n');

    const gitRunner = mock.fn(() => true);
    const report = validateSpecFreshness(body, {
      baseBranchRef: 'main',
      gitRunner,
    });

    assert.equal(report.stale.length, 0);
    assert.equal(report.ambiguous.length, 0);
    assert.equal(report.fresh.length, 2);
    const paths = report.fresh.map((r) => r.path).sort();
    assert.deepEqual(paths, ['lib/handlers/login.ts', 'src/auth.ts']);
  });

  it('marks absent paths as stale and reports the citation line numbers', () => {
    // Spread the citations across many lines so the cue-window (±80 chars)
    // around the stale reference contains no new-file cue from a sibling
    // sentence. Otherwise the bucketer correctly demotes stale → ambiguous.
    const filler = Array(15).fill('Some unrelated prose line.').join('\n');
    const body = [
      '## Tech Spec', // line 1
      '', // line 2
      'The change refactors `src/auth.ts` in place.', // line 3 - fresh
      filler, // lines 4-18
      'The replacement path uses `src/legacy-removed.ts` directly.', // line 19 - stale
    ].join('\n');

    const gitRunner = mock.fn(({ path }) => path === 'src/auth.ts');
    const report = validateSpecFreshness(body, {
      baseBranchRef: 'main',
      gitRunner,
    });

    assert.equal(report.stale.length, 1);
    assert.equal(report.fresh.length, 1);
    assert.equal(report.ambiguous.length, 0);
    assert.equal(report.stale[0].path, 'src/legacy-removed.ts');
    assert.equal(report.stale[0].line, 19);
  });

  it('recognises net-new file cues and demotes stale to ambiguous', () => {
    const body = [
      '## Tech Spec',
      '',
      'We introduce a new helper at `src/spec-freshness.js` that probes',
      'paths against the base ref.',
    ].join('\n');

    const gitRunner = mock.fn(() => false);
    const report = validateSpecFreshness(body, {
      baseBranchRef: 'main',
      gitRunner,
    });

    assert.equal(report.stale.length, 0);
    assert.equal(report.ambiguous.length, 1);
    assert.equal(report.ambiguous[0].path, 'src/spec-freshness.js');
  });

  it('extracts paths from code-block file headers and inline mentions', () => {
    const body = [
      '## Tech Spec',
      '',
      '```js',
      '// src/header.ts',
      'export const x = 1;',
      '```',
      '',
      'Also see lib/util.ts for the helper.',
    ].join('\n');

    const gitRunner = mock.fn(() => true);
    const report = validateSpecFreshness(body, {
      baseBranchRef: 'main',
      gitRunner,
    });

    const paths = report.fresh.map((r) => r.path).sort();
    assert.deepEqual(paths, ['lib/util.ts', 'src/header.ts']);
  });

  it('throws when baseBranchRef is missing', () => {
    assert.throws(() => validateSpecFreshness('body', {}), /baseBranchRef/);
  });

  it('treats specBody non-string as a type error', () => {
    assert.throws(
      () => validateSpecFreshness(null, { baseBranchRef: 'main' }),
      TypeError,
    );
  });
});

describe('renderSpecFreshnessComment — markdown shape', () => {
  it('produces a summary header with stale, ambiguous, and fresh counts', () => {
    const report = {
      stale: [{ path: 'src/x.ts', line: 3, citations: [{ line: 3 }] }],
      ambiguous: [],
      fresh: [{ path: 'src/y.ts', line: 5, citations: [{ line: 5 }] }],
    };
    const body = renderSpecFreshnessComment(report, {
      baseBranchRef: 'main',
      techSpecId: 1234,
      epicId: 999,
    });
    assert.match(body, /Tech Spec freshness check \(Epic #999\)/);
    assert.match(body, /1 stale · 0 ambiguous · 1 fresh against `main`/);
    assert.match(body, /`src\/x\.ts` \(L3\)/);
    assert.doesNotMatch(body, /`src\/y\.ts`/); // fresh paths are not listed individually
  });

  it('omits the stale section when no stale references are present', () => {
    const report = {
      stale: [],
      ambiguous: [{ path: 'src/a.ts', line: 2, citations: [{ line: 2 }] }],
      fresh: [],
    };
    const body = renderSpecFreshnessComment(report, {
      baseBranchRef: 'main',
      techSpecId: 1,
      epicId: 2,
    });
    assert.doesNotMatch(body, /### Stale references/);
    assert.match(body, /### Ambiguous references/);
  });
});

describe('runSpecFreshnessCheck — non-blocking integration', () => {
  it('writes a report file and skips the comment when nothing is stale', async () => {
    const writes = [];
    const fileWriter = async (path, body) => {
      writes.push({ path, body });
    };
    const commentUpserter = mock.fn(async () => {});
    const validator = mock.fn(() => ({
      stale: [],
      ambiguous: [],
      fresh: [{ path: 'src/auth.ts', line: 1, citations: [{ line: 1 }] }],
    }));

    const result = await runSpecFreshnessCheck({
      epicId: 100,
      techSpecId: 200,
      techSpecContent: '## Tech Spec\n',
      baseBranchRef: 'main',
      tempRoot: '/tmp/fixture',
      provider: {},
      validator,
      commentUpserter,
      fileWriter,
    });

    assert.equal(result.stale, 0);
    assert.equal(result.commentPosted, false);
    assert.equal(commentUpserter.mock.callCount(), 0);
    assert.equal(writes.length, 1);
    assert.match(writes[0].path, /epic-100-spec-freshness\.json$/);
    const payload = JSON.parse(writes[0].body);
    assert.equal(payload.summary.fresh, 1);
  });

  it('upserts a structured comment when stale references are found', async () => {
    const commentUpserter = mock.fn(async () => {});
    const validator = mock.fn(() => ({
      stale: [{ path: 'src/missing.ts', line: 4, citations: [{ line: 4 }] }],
      ambiguous: [],
      fresh: [],
    }));

    const result = await runSpecFreshnessCheck({
      epicId: 100,
      techSpecId: 200,
      techSpecContent: '## Tech Spec\n',
      baseBranchRef: 'main',
      tempRoot: '/tmp/fixture',
      provider: { id: 'fake-provider' },
      validator,
      commentUpserter,
      fileWriter: async () => {},
    });

    assert.equal(result.stale, 1);
    assert.equal(result.commentPosted, true);
    assert.equal(commentUpserter.mock.callCount(), 1);
    const call = commentUpserter.mock.calls[0];
    assert.deepEqual(call.arguments.slice(0, 3), [
      { id: 'fake-provider' },
      200,
      'spec-freshness',
    ]);
    assert.match(call.arguments[3], /1 stale/);
  });

  it('downgrades to a warning when the validator throws', async () => {
    const validator = () => {
      throw new Error('git ref unreachable');
    };

    const result = await runSpecFreshnessCheck({
      epicId: 100,
      techSpecId: 200,
      techSpecContent: '',
      baseBranchRef: 'main',
      tempRoot: '/tmp/fixture',
      provider: {},
      validator,
      commentUpserter: mock.fn(async () => {}),
      fileWriter: async () => {},
    });

    assert.equal(result.stale, 0);
    assert.equal(result.commentPosted, false);
    assert.equal(result.reportPath, null);
    assert.match(result.error, /git ref unreachable/);
  });

  it('skips comment upsert when techSpecId is null even with stale refs', async () => {
    const commentUpserter = mock.fn(async () => {});
    const validator = () => ({
      stale: [{ path: 'src/x.ts', line: 1, citations: [{ line: 1 }] }],
      ambiguous: [],
      fresh: [],
    });

    const result = await runSpecFreshnessCheck({
      epicId: 100,
      techSpecId: null,
      techSpecContent: '',
      baseBranchRef: 'main',
      tempRoot: '/tmp/fixture',
      provider: {},
      validator,
      commentUpserter,
      fileWriter: async () => {},
    });

    assert.equal(result.commentPosted, false);
    assert.equal(commentUpserter.mock.callCount(), 0);
  });
});
