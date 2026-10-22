import assert from 'node:assert/strict';
import { test } from 'node:test';

import { readDiff } from '../../../../.agents/scripts/lib/orchestration/review-providers/generated-diff.js';

const SRC = 'diff --git a/src/a.js b/src/a.js\n+const a = 1;\n';
const GEN =
  'diff --git a/lib/generated/v.js b/lib/generated/v.js\n+minified();\n';
const DIFF = `${SRC}${GEN}`;
const RANGE = { baseRef: 'origin/main', headRef: 'story-1' };

/**
 * `git diff` answers `diff`; `git check-attr` marks `generated` true and
 * every other path unspecified, unless `attr` overrides the whole reply.
 */
function git({ diff = DIFF, generated = [], attr, calls = [] } = {}) {
  return (cwd, ...args) => {
    calls.push({ cwd, args });
    if (args[0] === 'diff') return { status: 0, stdout: diff, stderr: '' };
    if (attr) return attr;
    const stdout = args
      .slice(args.indexOf('--') + 1)
      .map(
        (p) =>
          `${p}\0linguist-generated\0${generated.includes(p) ? 'true' : 'unspecified'}\0`,
      )
      .join('');
    return { status: 0, stdout, stderr: '' };
  };
}

test('a linguist-generated file is reduced to a one-line stub', () => {
  const calls = [];
  const result = readDiff(
    git({ generated: ['lib/generated/v.js'], calls }),
    RANGE,
    '/repo',
  );
  assert.equal(
    result.text,
    `${SRC}diff --git a/lib/generated/v.js b/lib/generated/v.js\n[generated file: changed, content omitted from review]\n`,
  );
  assert.deepEqual(result.omitted, ['lib/generated/v.js']);
  assert.deepEqual(calls, [
    { cwd: '/repo', args: ['diff', '--no-color', 'origin/main...story-1'] },
    {
      cwd: '/repo',
      args: [
        'check-attr',
        '-z',
        'linguist-generated',
        '--',
        'src/a.js',
        'lib/generated/v.js',
      ],
    },
  ]);
});

test('the bare `set` form of the attribute counts as generated', () => {
  const attr = {
    status: 0,
    stdout: 'src/a.js\0linguist-generated\0set\0',
    stderr: '',
  };
  assert.deepEqual(readDiff(git({ diff: SRC, attr }), RANGE, '/r').omitted, [
    'src/a.js',
  ]);
});

test('nothing generated leaves the diff byte-identical', () => {
  assert.deepEqual(readDiff(git(), RANGE, '/r'), { text: DIFF, omitted: [] });
});

test('a failed attribute lookup keeps the whole diff', () => {
  const attr = { status: 128, stdout: '', stderr: 'boom' };
  assert.deepEqual(readDiff(git({ attr }), RANGE, '/r'), {
    text: DIFF,
    omitted: [],
  });
});

test('a diff with no file sections makes no attribute lookup', () => {
  const calls = [];
  assert.deepEqual(readDiff(git({ diff: '\n', calls }), RANGE, '/r'), {
    text: '\n',
    omitted: [],
  });
  assert.equal(calls.length, 1);
});

test('a failed git diff is a reason, not a diff', () => {
  const gitSpawnFn = () => ({ status: 128, stdout: '', stderr: 'bad rev' });
  assert.deepEqual(readDiff(gitSpawnFn, RANGE, '/r'), {
    reason: 'git diff origin/main...story-1 failed: bad rev',
  });
});
