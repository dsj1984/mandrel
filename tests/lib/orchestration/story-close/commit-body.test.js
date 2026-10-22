// Story #5859 — close-time commit bodies stay within commitlint's 100 chars.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';

import {
  closeGitSync,
  refusalMark,
} from '../../../../.agents/scripts/lib/orchestration/story-close/commit-body.js';
import {
  installStrictCommitMsgHook,
  makeGitRepo,
  seedGitIdentity,
} from '../../../fixtures/git-fixture.js';

const CONSUMER_PATH =
  'apps/staff/src/pages/api/v1/finance/training-refund-reviews/[registrationId]/refund.ts';

function strictRepo() {
  const dir = makeGitRepo({ prefix: 'commit-body-' });
  seedGitIdentity(dir);
  installStrictCommitMsgHook(dir);
  return dir;
}

function committedBody(dir, body) {
  closeGitSync(dir, 'commit', '--allow-empty', '-m', 'chore: s', '-m', body);
  const lines = closeGitSync(dir, 'log', '-1', '--format=%b').split('\n');
  for (const line of lines) {
    assert.ok(line.length <= 100, `${line.length}: ${line}`);
  }
  return lines;
}

describe('closeGitSync — body bound (AC-1, AC-3, AC-5)', () => {
  test('a short row is committed on one line, unchanged', () => {
    const dir = strictRepo();
    assert.deepEqual(committedBody(dir, 'Intro.\n\n- src/a.js: 20% -> none'), [
      'Intro.',
      '',
      '- src/a.js: 20% -> none',
    ]);
  });

  test('the consumer row re-flows: path line, then an indented delta', () => {
    const row = `- ${CONSUMER_PATH}: 11.25% -> 10.11%`;
    assert.equal(row.length, 106, 'the hook refused this before the fix');
    assert.deepEqual(committedBody(strictRepo(), row), [
      `- ${CONSUMER_PATH}`,
      '  11.25% -> 10.11%',
    ]);
  });

  test('a path over 98 chars is cut from the left at a segment boundary', () => {
    const deep = `packages/${'deeply-nested-module/'.repeat(5)}index.js`;
    assert.ok(deep.length > 100);
    const [pathLine, delta] = committedBody(
      strictRepo(),
      `- ${deep}: 70.00 -> 78.00`,
    );
    assert.match(pathLine, /^- …\/deeply-nested-module\/.*\/index\.js$/);
    assert.ok(deep.endsWith(pathLine.slice('- …/'.length)));
    assert.equal(delta, '  70.00 -> 78.00');
  });

  test('a single over-long segment, a long detail and long prose still fit', () => {
    const lines = committedBody(
      strictRepo(),
      [
        `- ${'x'.repeat(150)}: removed`,
        `- src/a.js: symbol${'Name'.repeat(40)}`,
        'p'.repeat(140),
      ].join('\n'),
    );
    assert.ok(lines[0].startsWith('- …/x'));
    assert.equal(lines[1], '  removed');
    assert.equal(lines[2], '- src/a.js');
    assert.ok(lines[3].startsWith('  symbolName') && lines[3].endsWith('…'));
    assert.ok(lines[4].endsWith('…'));
  });

  test('every row is kept, in order', () => {
    const rows = [
      `- ${CONSUMER_PATH}: 11.25% -> 10.11%`,
      '- src/b.js: 3% -> 4%',
      `- ${CONSUMER_PATH}x: 5% -> none`,
    ];
    const lines = committedBody(strictRepo(), rows.join('\n'));
    assert.deepEqual(
      lines.filter((l) => l.startsWith('- ')),
      [`- ${CONSUMER_PATH}`, '- src/b.js: 3% -> 4%', `- ${CONSUMER_PATH}x`],
    );
  });

  test('a non-commit command passes straight through', () => {
    assert.equal(
      closeGitSync(strictRepo(), 'rev-parse', '--abbrev-ref', 'HEAD'),
      'main',
    );
  });
});

describe('closeGitSync — a refused commit (AC-4)', () => {
  const refuseWith = (script) => {
    const dir = strictRepo();
    fs.writeFileSync(path.join(dir, '.githooks', 'commit-msg'), script, {
      mode: 0o755,
    });
    return () =>
      closeGitSync(dir, 'commit', '--allow-empty', '-m', 'chore: s', '-m', 'b');
  };

  test('names the commitlint rule the hook printed', () => {
    assert.throws(
      refuseWith(
        "#!/bin/sh\necho \"✖   body's lines must not be longer than 100 characters [body-max-line-length]\" >&2\necho 'husky - commit-msg script failed (code 1)' >&2\nexit 1\n",
      ),
      {
        name: 'CommitRefusedError',
        message:
          'commit-refused: commit-msg hook refused it [body-max-line-length]',
      },
    );
  });

  test('a bracketed path segment in the body is not read as a rule', () => {
    const dir = strictRepo();
    fs.writeFileSync(
      path.join(dir, '.githooks', 'commit-msg'),
      "#!/bin/sh\necho 'husky - commit-msg script failed (code 1)' >&2\nexit 1\n",
      { mode: 0o755 },
    );
    assert.throws(
      () =>
        closeGitSync(
          dir,
          'commit',
          '--allow-empty',
          '-m',
          'chore: s',
          '-m',
          '- pages/[slug]/index.ts: 1% -> 2%',
        ),
      { message: 'commit-refused: husky - commit-msg script failed (code 1)' },
    );
  });

  test('without a rule, names the last line the hook printed', () => {
    assert.throws(
      refuseWith(
        "#!/bin/sh\necho 'husky - commit-msg script failed (code 1)' >&2\nexit 1\n",
      ),
      { message: 'commit-refused: husky - commit-msg script failed (code 1)' },
    );
  });
});

describe('refusalMark (AC-4)', () => {
  test('warns on a refusal and stays quiet on an ordinary skip', (t) => {
    const warn = t.mock.method(console, 'warn', () => {});
    const error = t.mock.method(console, 'error', () => {});
    const logged = () =>
      [...warn.mock.calls, ...error.mock.calls].map((c) => c.arguments[0]);
    assert.equal(refusalMark('DUPLICATION', 'unchanged'), '⏭');
    assert.equal(refusalMark('DUPLICATION', undefined), '⏭');
    assert.deepEqual(logged(), []);
    assert.equal(
      refusalMark('DUPLICATION', 'git-failed: commit-refused: boom [rule-x]'),
      '⚠️',
    );
    assert.equal(logged().length, 1);
    assert.match(
      logged()[0],
      /⚠️ \[DUPLICATION\] baseline commit refused.*\[rule-x\]/,
    );
  });
});
