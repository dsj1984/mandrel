/**
 * tests/contract/single-story-close/normalize-pr-title.test.js
 *
 * Story #3969 — normalize delivery PR titles to Conventional Commits so
 * squash-merges trigger release-please.
 *
 * The repo squash-merges and GitHub uses the PR title as the squash-commit
 * subject on `main`. A non-conventional subject is silently counted as 0
 * releasable commits by release-please, so no release is cut. These tests
 * lock the contract that the standalone-Story PR title (and, by regression
 * assertion, the Epic-finalize default) always parses as a Conventional
 * Commit.
 *
 * Parseability is asserted via the **same** `@commitlint/lint` +
 * `@commitlint/load` pair the `commit-msg` hook and CI use, so the test
 * fails the moment a title would be rejected on `main`.
 *
 * Asserts:
 *   1. A non-conventional story title is synthesized into conventional
 *      form (and parses).
 *   2. An already-conventional story title is preserved verbatim, with
 *      only the `(#id)` suffix appended (and parses).
 *   3. The type is derived from the branch's own conventional commit
 *      subjects, with a `chore` fallback when none can be read.
 *   4. The `ensurePullRequestWith` phase passes a conventional title to
 *      `gh pr create` and keeps `Closes #<id>` in the body.
 *   5. The Epic-finalize default title (`openOrLocatePr`) is conventional
 *      (regression: it was already normalized before #3969).
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { openOrLocatePr } from '../../../.agents/scripts/lib/orchestration/finalize/open-or-locate-pr.js';
import {
  DEFAULT_CONVENTIONAL_TYPE,
  deriveTypeFromBranchCommits,
  isConventionalSubject,
  normalizePrTitle,
  parseConventionalType,
  pickDominantType,
} from '../../../.agents/scripts/lib/orchestration/single-story-close/phases/normalize-pr-title.js';
import { ensurePullRequestWith } from '../../../.agents/scripts/lib/orchestration/single-story-close/phases/pull-request.js';

const silentLogger = { warn: () => {} };

/**
 * Assert a subject parses under the repo's real commitlint config — the
 * faithful proxy for "release-please can parse the squash subject on
 * `main`". Lazily imports commitlint so the test exercises the installed
 * version, resolving the CJS/ESM default-export shape the same way
 * merge-subject.js does.
 */
async function assertParsesAsConventional(subject) {
  const lintMod = await import('@commitlint/lint');
  const loadMod = await import('@commitlint/load');
  const lint = lintMod.default ?? lintMod.lint ?? lintMod;
  const load = loadMod.default ?? loadMod.load ?? loadMod;
  const cfg = await load({}, { cwd: process.cwd() });
  const report = await lint(subject, cfg.rules);
  // A non-conventional header surfaces `subject-empty` / `type-empty`
  // commitlint errors — the exact failure release-please's parser emits.
  const typeErrors = report.errors.filter(
    (e) => e.name === 'type-empty' || e.name === 'subject-empty',
  );
  assert.deepEqual(
    typeErrors,
    [],
    `subject is not a parseable Conventional Commit: "${subject}" — ${JSON.stringify(
      report.errors.map((e) => e.name),
    )}`,
  );
}

/** A scripted gitSpawn that returns a fixed `git log` stdout. */
function gitSpawnReturning(stdout, status = 0) {
  return () => ({ status, stdout, stderr: '' });
}

describe('isConventionalSubject', () => {
  it('accepts a plain type:subject', () => {
    assert.equal(isConventionalSubject('fix: do a thing'), true);
  });

  it('accepts a scoped, breaking subject', () => {
    assert.equal(
      isConventionalSubject('refactor(core)!: rename package'),
      true,
    );
  });

  it('rejects a raw human title', () => {
    assert.equal(
      isConventionalSubject('Rename the published npm package'),
      false,
    );
  });

  it('rejects an unknown type', () => {
    assert.equal(isConventionalSubject('wip: half a thing'), false);
  });

  it('rejects an empty subject after the colon', () => {
    assert.equal(isConventionalSubject('fix: '), false);
  });
});

describe('parseConventionalType / pickDominantType', () => {
  it('extracts the leading type', () => {
    assert.equal(parseConventionalType('feat(scope): add'), 'feat');
    assert.equal(parseConventionalType('Raw title'), null);
  });

  it('picks the most release-significant type', () => {
    assert.equal(pickDominantType(['chore', 'fix', 'docs']), 'fix');
    assert.equal(pickDominantType(['docs', 'chore']), 'docs');
    assert.equal(pickDominantType(['chore']), 'chore');
    assert.equal(pickDominantType([]), null);
  });
});

describe('deriveTypeFromBranchCommits', () => {
  it('derives the dominant type from branch commit subjects', () => {
    const type = deriveTypeFromBranchCommits({
      storyBranch: 'story-1',
      baseBranch: 'main',
      gitSpawn: gitSpawnReturning(
        'chore: tidy\nfeat(x): add a feature\ndocs: note it',
      ),
      logger: silentLogger,
    });
    assert.equal(type, 'feat');
  });

  it('falls back to chore when no conventional subject is present', () => {
    const type = deriveTypeFromBranchCommits({
      storyBranch: 'story-1',
      baseBranch: 'main',
      gitSpawn: gitSpawnReturning('wip stuff\nmore stuff'),
      logger: silentLogger,
    });
    assert.equal(type, DEFAULT_CONVENTIONAL_TYPE);
  });

  it('falls back to chore when git log fails', () => {
    const type = deriveTypeFromBranchCommits({
      storyBranch: 'story-1',
      baseBranch: 'main',
      gitSpawn: gitSpawnReturning('', 128),
      logger: silentLogger,
    });
    assert.equal(type, DEFAULT_CONVENTIONAL_TYPE);
  });
});

describe('normalizePrTitle', () => {
  it('synthesizes conventional form for a non-conventional title', async () => {
    const title = normalizePrTitle({
      storyTitle: 'Rename the published npm package',
      storyId: 3955,
      storyBranch: 'story-3955',
      baseBranch: 'main',
      gitSpawn: gitSpawnReturning('refactor!: rename the package'),
      logger: silentLogger,
    });
    assert.equal(title, 'refactor: Rename the published npm package (#3955)');
    await assertParsesAsConventional(title);
  });

  it('defaults to chore when the branch has no conventional commits', async () => {
    const title = normalizePrTitle({
      storyTitle: 'Some plain description',
      storyId: 42,
      storyBranch: 'story-42',
      baseBranch: 'main',
      gitSpawn: gitSpawnReturning('wip\nmore wip'),
      logger: silentLogger,
    });
    assert.equal(title, 'chore: Some plain description (#42)');
    await assertParsesAsConventional(title);
  });

  it('preserves an already-conventional title verbatim + (#id) suffix', async () => {
    const storyTitle =
      'fix(delivery): normalize PR titles to Conventional Commits';
    const title = normalizePrTitle({
      storyTitle,
      storyId: 3969,
      storyBranch: 'story-3969',
      baseBranch: 'main',
      // gitSpawn must NOT be consulted on the already-conventional path.
      gitSpawn: () => {
        throw new Error(
          'gitSpawn should not be called for a conventional title',
        );
      },
      logger: silentLogger,
    });
    assert.equal(title, `${storyTitle} (#3969)`);
    await assertParsesAsConventional(title);
  });

  it('never double-prefixes a conventional title', () => {
    const title = normalizePrTitle({
      storyTitle: 'feat: add a thing',
      storyId: 7,
      storyBranch: 'story-7',
      baseBranch: 'main',
      gitSpawn: gitSpawnReturning('feat: add a thing'),
      logger: silentLogger,
    });
    assert.equal(title, 'feat: add a thing (#7)');
    assert.equal(/^(feat|fix|chore): (feat|fix|chore):/.test(title), false);
  });

  it('synthesizes a Story #id description for an empty title', async () => {
    const title = normalizePrTitle({
      storyTitle: '   ',
      storyId: 99,
      storyBranch: 'story-99',
      baseBranch: 'main',
      gitSpawn: gitSpawnReturning('fix: a thing'),
      logger: silentLogger,
    });
    assert.equal(title, 'fix: Story #99 (#99)');
    await assertParsesAsConventional(title);
  });
});

describe('ensurePullRequestWith — PR title is conventional', () => {
  /**
   * Fake `gh` facade: no open PR on probe, capture the create args.
   */
  function fakeGh(capture) {
    return {
      pr: {
        list: async () => [],
        create: async (args) => {
          capture.args = args;
          return { stdout: 'https://github.com/o/r/pull/123' };
        },
      },
    };
  }

  it('passes a synthesized conventional title to gh pr create for a raw story title', async () => {
    const capture = {};
    const url = await ensurePullRequestWith({
      cwd: process.cwd(),
      storyId: 3955,
      storyTitle: 'Rename the published npm package',
      storyBranch: 'story-3955',
      baseBranch: 'main',
      gh: fakeGh(capture),
    });
    assert.equal(url, 'https://github.com/o/r/pull/123');
    const titleIdx = capture.args.indexOf('--title');
    const title = capture.args[titleIdx + 1];
    // The title is derived against the real (test) git tree; whatever the
    // branch contributes, the result MUST be conventional and carry (#id).
    assert.ok(isConventionalSubject(title), `not conventional: "${title}"`);
    assert.ok(title.includes('(#3955)'));
    await assertParsesAsConventional(title);
  });

  it('preserves an already-conventional story title and keeps Closes #id in the body', async () => {
    const capture = {};
    await ensurePullRequestWith({
      cwd: process.cwd(),
      storyId: 3969,
      storyTitle: 'fix(delivery): normalize PR titles',
      storyBranch: 'story-3969',
      baseBranch: 'main',
      gh: fakeGh(capture),
    });
    const titleIdx = capture.args.indexOf('--title');
    assert.equal(
      capture.args[titleIdx + 1],
      'fix(delivery): normalize PR titles (#3969)',
    );
    const bodyIdx = capture.args.indexOf('--body');
    assert.ok(capture.args[bodyIdx + 1].includes('Closes #3969'));
  });
});

describe('Epic finalize PR title — regression (already normalized before #3969)', () => {
  /**
   * Scripted gh spawn: empty probe → create → view. Captures the create
   * args so the default title can be asserted.
   */
  function scriptedFinalizeGh(capture) {
    const queue = [
      { status: 0, stdout: '', stderr: '' }, // pr list (no existing PR)
      { status: 0, stdout: 'https://github.com/o/r/pull/55', stderr: '' }, // pr create
      {
        status: 0,
        stdout: '{"number":55,"url":"https://github.com/o/r/pull/55"}',
        stderr: '',
      }, // pr view
    ];
    return ({ args }) => {
      if (args[1] === 'create') capture.args = args;
      return queue.shift();
    };
  }

  it('defaults the epic/<id> → main PR title to a conventional subject', async () => {
    const capture = {};
    const result = await openOrLocatePr({
      epicId: 2172,
      headBranch: 'epic/2172',
      baseBranch: 'main',
      ghSpawn: scriptedFinalizeGh(capture),
    });
    assert.equal(result.created, true);
    const titleIdx = capture.args.indexOf('--title');
    const title = capture.args[titleIdx + 1];
    assert.equal(title, 'feat: Epic #2172');
    assert.ok(isConventionalSubject(title), `not conventional: "${title}"`);
    await assertParsesAsConventional(title);
  });
});
