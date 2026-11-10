/**
 * orchestrate-ledger — authority recorded once, actions refused unless
 * granted, a raise reaching the operator once per PR and state, and the
 * hand-back summary rendered from the ledger alone.
 */

import assert from 'node:assert/strict';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, it } from 'node:test';
import { orchestrateRunDir } from '../.agents/scripts/lib/config/temp-paths.js';
import {
  ACTION_DEFAULTS,
  ledgerPath,
  readLedger,
  recordAction,
  recordAuthority,
  recordSweep,
  renderSummary,
  summarize,
  sweepChanges,
} from '../.agents/scripts/lib/orchestrate/ledger.js';
import { makeTempDir } from '../.agents/scripts/lib/test-temp.js';
import {
  parseLedgerArgv,
  runLedgerCommand,
} from '../.agents/scripts/orchestrate-ledger.js';

let file;
beforeEach(() => {
  file = path.join(makeTempDir('orchestrate-ledger-'), 'ledger.ndjson');
});

const sink = () => {
  const chunks = [];
  return { write: (c) => chunks.push(c), text: () => chunks.join('') };
};

function cli(argv, at = Date.parse('2026-11-10T12:00:00Z')) {
  const out = sink();
  const err = sink();
  const code = runLedgerCommand(parseLedgerArgv(argv), {
    file,
    now: at,
    out,
    err,
  });
  return { code, out: out.text(), err: err.text() };
}

describe('authority', () => {
  it('offers the closed action set with its defaults', () => {
    assert.deepEqual(ACTION_DEFAULTS, {
      'message-session': 'yes',
      'fix-base': 'yes',
      requeue: 'ask',
      'arm-auto-merge': 'ask',
      'push-to-branch': 'no',
      'spawn-session': 'ask',
      'release-dispatch': 'no',
      'archive-and-reap': 'ask',
    });
  });

  it('records the grants once and refuses a second record or an unknown action', () => {
    assert.equal(
      cli([
        'authority',
        '--run-id',
        'r1',
        '--grant',
        'message-session,fix-base',
      ]).code,
      0,
    );
    assert.equal(
      recordAuthority({ file, grants: ['requeue'] }).reason,
      'authority-already-recorded',
    );
    const fresh = path.join(path.dirname(file), 'other.ndjson');
    assert.match(
      recordAuthority({ file: fresh, grants: ['deploy'] }).reason,
      /unknown-action: deploy/,
    );
    assert.equal(existsSync(fresh), false);
    assert.deepEqual(
      readLedger(file).map((r) => r.grants),
      [['message-session', 'fix-base']],
    );
  });
});

describe('record (AC-7)', () => {
  beforeEach(() => {
    recordAuthority({ file, grants: ['message-session'] });
  });

  it('exits non-zero and writes nothing for an action not granted', () => {
    const before = readFileSync(file, 'utf8');
    const res = cli([
      'record',
      '--run-id',
      'r1',
      '--action',
      'requeue',
      '--pr',
      '5',
      '--text',
      'requeue it',
    ]);
    assert.equal(res.code, 2);
    assert.match(res.err, /not-granted: requeue/);
    assert.equal(readFileSync(file, 'utf8'), before);
  });

  it('records a granted action', () => {
    const res = cli([
      'record',
      '--run-id',
      'r1',
      '--action',
      'message-session',
      '--pr',
      '5',
      '--text',
      'told the owner',
    ]);
    assert.equal(res.code, 0);
    assert.equal(JSON.parse(res.out).action, 'message-session');
  });

  it('refuses a second raise for the same PR and state, but not after the state moved', () => {
    recordSweep({ file, states: { 5: 'ejected' }, merged: [] });
    const raise = () =>
      recordAction({ file, action: 'raise', pr: 5, text: 'requeue blocked' });
    assert.equal(raise().ok, true);
    assert.deepEqual(raise(), { ok: false, reason: 'already-raised' });
    recordSweep({ file, states: { 5: 'green-not-queued' }, merged: [] });
    assert.equal(raise().ok, true);
  });

  it('refuses anything before authority, an unknown action, and a multi-line text', () => {
    const blank = path.join(path.dirname(file), 'blank.ndjson');
    assert.equal(
      recordAction({ file: blank, action: 'raise', text: 'x' }).reason,
      'no-authority',
    );
    assert.match(
      recordAction({ file, action: 'deploy', text: 'x' }).reason,
      /unknown-action/,
    );
    assert.equal(
      recordAction({ file, action: 'raise', text: 'a\nb' }).reason,
      'text-must-be-one-line',
    );
  });

  it('rejects malformed argv', () => {
    assert.throws(() => parseLedgerArgv(['bogus', '--run-id', 'r']));
    assert.throws(() => parseLedgerArgv(['summary']), /--run-id/);
    assert.throws(
      () => parseLedgerArgv(['record', '--run-id', 'r']),
      /--action/,
    );
    assert.throws(
      () =>
        parseLedgerArgv([
          'record',
          '--run-id',
          'r',
          '--action',
          'raise',
          '--pr',
          '0',
        ]),
      /--pr/,
    );
  });
});

describe('summary (AC-9)', () => {
  it('lists merged PRs, open PRs with state, waiting decisions and follow-ups from the ledger alone', () => {
    recordAuthority({ file, grants: ['arm-auto-merge'] });
    recordSweep({
      file,
      states: { 3: 'ejected', 4: 'green-not-queued' },
      merged: [{ number: 2, storyId: 20 }],
    });
    recordAction({
      file,
      action: 'raise',
      pr: 3,
      text: 'requeue needs a grant',
    });
    recordAction({ file, action: 'arm-auto-merge', pr: 4, text: 'armed' });
    recordAction({
      file,
      action: 'follow-up',
      story: 20,
      text: 'filed #99 for the flaky probe',
    });
    recordSweep({
      file,
      states: { 3: 'ejected' },
      merged: [{ number: 4, storyId: null }],
    });

    const summary = summarize(readLedger(file));
    assert.deepEqual(
      summary.merged.map((m) => m.number),
      [2, 4],
    );
    assert.deepEqual(summary.open, [{ number: 3, state: 'ejected' }]);
    assert.deepEqual(
      summary.waiting.map((r) => r.text),
      ['requeue needs a grant'],
    );
    assert.deepEqual(
      summary.followUps.map((r) => r.text),
      ['filed #99 for the flaky probe'],
    );

    const text = cli(['summary', '--run-id', 'r1']).out;
    assert.match(text, /Merged \(2\)\n- PR #2 \(Story #20\)\n- PR #4/);
    assert.match(text, /Still open \(1\)\n- PR #3: ejected/);
    assert.match(
      text,
      /Waiting on the operator \(1\)\n- PR #3: requeue needs a grant/,
    );
    assert.match(text, /Follow-ups filed \(1\)\n- Story #20: filed #99/);
    assert.match(text, /Actions taken \(1\)\n- arm-auto-merge PR #4: armed/);
    assert.deepEqual(
      JSON.parse(cli(['summary', '--run-id', 'r1', '--json']).out).open,
      summary.open,
    );
  });

  it('an empty ledger renders empty sections', () => {
    assert.match(renderSummary(summarize([])), /Merged \(0\)/);
  });
});

describe('sweep diff and paths', () => {
  it('reports new, moved and gone PRs', () => {
    assert.deepEqual(
      sweepChanges({ 1: 'moving', 2: 'stale' }, { 1: 'moving', 3: 'stale' }),
      [
        { number: 2, from: 'stale', to: null },
        { number: 3, from: null, to: 'stale' },
      ],
    );
  });

  it('keeps the ledger under <tempRoot>/orchestrate/<run-id>/ and rejects a traversal id', () => {
    const tempRoot = makeTempDir('orchestrate-root-');
    const config = { project: { paths: { tempRoot } } };
    assert.equal(
      ledgerPath('20261110-a', config),
      path.join(tempRoot, 'orchestrate', '20261110-a', 'ledger.ndjson'),
    );
    assert.throws(() => orchestrateRunDir('../x', config), /path separators/);
  });

  it('skips a torn line', () => {
    recordAuthority({ file, grants: [] });
    appendFileSync(file, '{"kind":"sw');
    assert.equal(readLedger(file).length, 1);
  });
});
