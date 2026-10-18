import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  attachDelivered,
  parseShortstat,
  resolveDelivered,
} from '../../../scripts/lib/agent-cost/delivered-diff.js';

const SHA = 'a'.repeat(40);

/**
 * A fake git seam over a map of landed Stories; records every call.
 *
 * @param {{ landed?: Record<number, string>, baseExists?: boolean }} [opts]
 */
function fakeGit({ landed = {}, baseExists = true } = {}) {
  const calls = [];
  const gitFn = (args) => {
    calls.push(args);
    if (args[0] === 'rev-parse') return baseExists ? SHA : null;
    if (args[0] === 'log') {
      const id = Number(/\(refs #(\d+)\)/.exec(args[3])[1]);
      return landed[id] ? `${id}`.padStart(40, '0') : '';
    }
    if (args[0] === 'show') {
      const id = Number(args[3]);
      return landed[id] ?? null;
    }
    return null;
  };
  return { gitFn, calls };
}

function sink() {
  const chunks = [];
  return { write: (s) => chunks.push(s), text: () => chunks.join('') };
}

describe('parseShortstat', () => {
  it('reads files, insertions and deletions, defaulting absent parts to 0', () => {
    assert.deepEqual(
      parseShortstat(' 16 files changed, 506 insertions(+), 71 deletions(-)'),
      { files: 16, insertions: 506, deletions: 71 },
    );
    assert.deepEqual(parseShortstat(' 1 file changed, 1 insertion(+)'), {
      files: 1,
      insertions: 1,
      deletions: 0,
    });
  });
});

describe('resolveDelivered', () => {
  it('matches the first-parent squash subject by fixed string on the base ref', () => {
    const { gitFn, calls } = fakeGit({
      landed: { 5755: ' 16 files changed, 506 insertions(+), 71 deletions(-)' },
    });
    const delivered = resolveDelivered(5755, { gitFn, baseRef: 'origin/main' });
    assert.deepEqual(delivered, {
      sha: '5755'.padStart(40, '0'),
      files: 16,
      insertions: 506,
      deletions: 71,
    });
    assert.deepEqual(calls[0], [
      'log',
      '--first-parent',
      '--fixed-strings',
      '--grep=(refs #5755)',
      '--format=%H',
      '-n',
      '1',
      'origin/main',
    ]);
  });

  it('returns null for an unlanded Story', () => {
    const { gitFn } = fakeGit();
    assert.equal(resolveDelivered(1, { gitFn, baseRef: 'origin/main' }), null);
  });
});

describe('attachDelivered', () => {
  it('resolves each distinct storyId once and nulls unlanded and storyless rows', () => {
    const { gitFn, calls } = fakeGit({
      landed: { 10: ' 2 files changed, 30 insertions(+), 10 deletions(-)' },
    });
    const stderr = sink();
    const rows = attachDelivered(
      [{ storyId: 10 }, { storyId: 10 }, { storyId: 11 }, { storyId: null }],
      { gitFn, baseRef: 'origin/main', stderr },
    );
    assert.equal(rows[0].delivered.insertions, 30);
    assert.equal(rows[1].delivered, rows[0].delivered);
    assert.equal(rows[2].delivered, null);
    assert.equal(rows[3].delivered, null);
    assert.equal(calls.filter((c) => c[0] === 'log').length, 2);
    assert.match(
      stderr.text(),
      /no landed commit on origin\/main for Story #11/,
    );
  });

  it('degrades every row to null with one warning when the base ref is missing', () => {
    const { gitFn, calls } = fakeGit({
      landed: { 10: ' 1 file changed, 1 insertion(+)' },
      baseExists: false,
    });
    const stderr = sink();
    const rows = attachDelivered([{ storyId: 10 }], {
      gitFn,
      baseRef: 'nope/main',
      stderr,
    });
    assert.equal(rows[0].delivered, null);
    assert.deepEqual(
      calls.map((c) => c[0]),
      ['rev-parse'],
    );
    assert.match(stderr.text(), /base ref not found: nope\/main/);
  });

  it('runs no git when no row carries a storyId', () => {
    const { gitFn, calls } = fakeGit();
    const rows = attachDelivered([{ storyId: null }], {
      gitFn,
      baseRef: 'origin/main',
    });
    assert.equal(rows[0].delivered, null);
    assert.equal(calls.length, 0);
  });
});
