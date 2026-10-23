/**
 * normalize-pr-title.test.js — the assembled PR title and body.
 *
 * `conventional-subject.test.js` pins the rules in isolation; this file drives
 * the module's one public seam, `buildPullRequestFields`, with an injected
 * `git log` so the branch read is exercised for real: the NUL record split,
 * the oldest-first ordering the type tie-break depends on, and the degraded
 * path when git cannot answer.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { buildPullRequestFields } from '../normalize-pr-title.js';
import { liftTrailers } from '../pr-body-trailers.js';

const NUL = String.fromCharCode(0);

/** A `gitSpawn` stand-in that replays `messages` as one `git log` payload. */
function gitLog(messages) {
  const calls = [];
  const fn = (cwd, ...args) => {
    calls.push({ cwd, args });
    return { status: 0, stdout: messages.map((m) => `${m}${NUL}\n`).join('') };
  };
  fn.calls = calls;
  return fn;
}

/** Build fields for `storyTitle` against a canned branch history. */
function build({
  storyTitle,
  storyId = 4321,
  storyBody = '',
  messages = [],
  trailerKeys,
}) {
  return buildPullRequestFields({
    storyTitle,
    storyId,
    storyBody,
    storyBranch: `story-${storyId}`,
    baseBranch: 'main',
    cwd: '/repo',
    gitSpawn: gitLog(messages),
    config: trailerKeys && {
      delivery: { pullRequest: { bodyTrailers: trailerKeys } },
    },
  });
}

// ---------------------------------------------------------------------------
// Title
// ---------------------------------------------------------------------------

test('an already-conventional Story title is preserved verbatim', () => {
  const { title } = build({
    storyTitle:
      'feat(gates): make the dead-exports ratchet detect whole-file death',
    storyId: 5001,
    messages: ['docs: unrelated'],
  });
  assert.equal(
    title,
    'feat(gates): make the dead-exports ratchet detect whole-file death (#5001)',
  );
});

test('a prose title is synthesized with the branch dominant type', () => {
  const { title } = build({
    storyTitle: 'Check/CI gate sweep: retire vacuous and orphaned gates',
    storyId: 5004,
    messages: [
      'chore(gates): retire vacuous gates (refs #5004)\n\nbody',
      'docs(ci): rewrite entry 2 (refs #5004)',
      'chore(baselines): prune orphan rows (refs #5004)',
    ],
  });
  assert.equal(
    title,
    'chore: check/CI gate sweep: retire vacuous and orphaned gates (#5004)',
  );
});

test('an acronym-led title keeps its casing', () => {
  const { title } = build({
    storyTitle: 'CRAP surface diet: delete the dead combined scan',
    storyId: 5002,
    messages: ['refactor(crap): delete the dead combined scan'],
  });
  assert.equal(
    title,
    'refactor: CRAP surface diet: delete the dead combined scan (#5002)',
  );
});

test('no commits → the safe default type', () => {
  const { title, breaking } = build({
    storyTitle: 'Rename the published npm package',
    storyId: 42,
  });
  assert.equal(title, 'chore: rename the published npm package (#42)');
  assert.equal(breaking, false);
});

test('an empty title falls back to the Story reference', () => {
  assert.equal(
    build({ storyTitle: '   ', storyId: 42 }).title,
    'chore: story #42 (#42)',
  );
  assert.equal(
    build({ storyTitle: undefined, storyId: 42 }).title,
    'chore: story #42 (#42)',
  );
});

test('a declared break marks both title shapes', () => {
  const synthesized = build({
    storyTitle: 'Retire the lint-baseline shell',
    storyId: 5004,
    messages: [
      'chore(gates): retire the shell\n\nBREAKING CHANGE: delete `project.commands.lintBaseline`.',
    ],
  });
  assert.equal(
    synthesized.title,
    'chore!: retire the lint-baseline shell (#5004)',
  );
  assert.equal(synthesized.breaking, true);
  assert.deepEqual(synthesized.breakingNotes, [
    'delete `project.commands.lintBaseline`.',
  ]);

  const preserved = build({
    storyTitle: 'refactor(config): retire the lint-baseline shell',
    storyId: 5004,
    storyBody: 'BREAKING CHANGE: delete `project.commands.lintBaseline`.',
  });
  assert.equal(
    preserved.title,
    'refactor(config)!: retire the lint-baseline shell (#5004)',
  );
});

test('a title that already carries `!` is not double-marked', () => {
  const { title } = build({
    storyTitle: 'feat(api)!: drop the v1 endpoint',
    storyId: 7,
    messages: ['feat(api)!: drop the v1 endpoint'],
  });
  assert.equal(title, 'feat(api)!: drop the v1 endpoint (#7)');
});

// ---------------------------------------------------------------------------
// Body
// ---------------------------------------------------------------------------

test('the body carries the Closes footer, and nothing else when clean', () => {
  const { body } = build({ storyTitle: 'Tidy up', storyId: 5004 });
  assert.equal(body, 'Closes #5004\n\n_Auto-opened by `/mandrel-deliver`._');
});

test('the BREAKING CHANGE footer goes last', () => {
  const { body } = build({
    storyTitle: 'Tidy up',
    storyId: 5004,
    storyBody: 'BREAKING CHANGE: delete `project.commands.lintBaseline`.',
  });
  assert.match(body, /^Closes #5004\n/);
  assert.equal(
    body.split('\n').at(-1),
    'BREAKING CHANGE: delete `project.commands.lintBaseline`.',
  );
});

// ---------------------------------------------------------------------------
// Lifted trailers (Story #5875)
// ---------------------------------------------------------------------------

test('a declared trailer is lifted after the marker', () => {
  const { body } = build({
    storyTitle: 'Tidy up',
    storyId: 5004,
    trailerKeys: ['Policy-impact'],
    messages: [
      'fix(cart): tidy (refs #5004)\n\nPolicy-impact: none — cart-only edit',
    ],
  });
  assert.equal(
    body,
    'Closes #5004\n\n_Auto-opened by `/mandrel-deliver`._\n\nPolicy-impact: none — cart-only edit',
  );
});

test('the BREAKING CHANGE footer still goes after a lifted trailer', () => {
  const { body } = build({
    storyTitle: 'Tidy up',
    storyId: 5004,
    trailerKeys: ['Policy-impact'],
    storyBody: 'BREAKING CHANGE: drop v1.',
    messages: ['fix: tidy\n\nPolicy-impact: none — cart-only edit'],
  });
  const lines = body.split('\n');
  assert.equal(lines.at(-1), 'BREAKING CHANGE: drop v1.');
  assert.equal(lines.at(-3), 'Policy-impact: none — cart-only edit');
});

test('the last commit carrying a declared trailer wins, matched case-insensitively', () => {
  const { body } = build({
    storyTitle: 'Tidy up',
    trailerKeys: ['Policy-impact'],
    messages: [
      'fix: first\n\nPolicy-impact: high — older',
      'fix: second\n\npolicy-impact:   none — newer  ',
      'docs: third, no trailer',
      'docs: prose only\n\nThis paragraph mentions Policy-impact: nothing\nbut is prose.\n\nMore prose.',
    ],
  });
  assert.equal(body.split('\n').at(-1), 'Policy-impact: none — newer');
});

test('a declared key no commit carries appends nothing and logs one info line', () => {
  const infos = [];
  const lines = liftTrailers({
    commitMessages: [
      'fix: tidy',
      'Policy-impact: a subject line is not a trailer',
    ],
    config: { delivery: { pullRequest: { bodyTrailers: ['Policy-impact'] } } },
    logger: { info: (msg) => infos.push(msg) },
  });
  assert.deepEqual(lines, []);
  assert.equal(infos.length, 1);
  assert.match(infos[0], /\[normalize-pr-title\].*"Policy-impact"/);
  const { body } = build({
    storyTitle: 'Tidy up',
    storyId: 5004,
    trailerKeys: ['Policy-impact'],
    messages: ['fix: tidy'],
  });
  assert.equal(body, 'Closes #5004\n\n_Auto-opened by `/mandrel-deliver`._');
});

test('no declared keys leaves the body byte-identical even when trailers exist', () => {
  const { body } = build({
    storyTitle: 'Tidy up',
    storyId: 5004,
    messages: ['fix: tidy\n\nPolicy-impact: none'],
  });
  assert.equal(body, 'Closes #5004\n\n_Auto-opened by `/mandrel-deliver`._');
});

// ---------------------------------------------------------------------------
// The branch read
// ---------------------------------------------------------------------------

test('the branch read is oldest-first over the base..head range', () => {
  const gitSpawn = gitLog(['docs: older', 'chore: newer']);
  const { title } = buildPullRequestFields({
    storyTitle: 'A sweep',
    storyId: 1,
    storyBranch: 'story-1',
    baseBranch: 'main',
    cwd: '/repo',
    gitSpawn,
  });
  assert.deepEqual(gitSpawn.calls[0].args, [
    'log',
    '--no-merges',
    '--reverse',
    '--format=%B%x00',
    'main..story-1',
  ]);
  // Same hidden rank and same count → the oldest commit's type wins.
  assert.equal(title, 'docs: a sweep (#1)');
});

test('a failed or throwing read degrades to the default type', () => {
  const failing = () => ({ status: 128, stdout: '' });
  const throwing = () => {
    throw new Error('boom');
  };
  for (const gitSpawn of [failing, throwing]) {
    const { title, breaking } = buildPullRequestFields({
      storyTitle: 'A sweep',
      storyId: 1,
      storyBranch: 'story-1',
      baseBranch: 'main',
      cwd: '/repo',
      gitSpawn,
    });
    assert.equal(title, 'chore: a sweep (#1)');
    assert.equal(breaking, false);
  }
});
