/**
 * story-progress.test.js — the live phase record's writer (Story #5553).
 *
 * Pins the load-bearing invariants: the path helper (and that retention keys
 * the file to its Story), the atomic tmp-then-rename write, the never-throws
 * contract, and the recorder's clock fields. Every write lands under an
 * absolute per-test tempRoot, so the shared temp tree is never touched.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { storyProgressPath } from '../../config/temp-paths.js';
import { collectTempEntries } from '../../temp-retention.js';
import { makeTempDir } from '../../test-temp.js';
import {
  createStoryProgress,
  handoffStepName,
  STORY_PROGRESS_KIND,
  writeStoryProgress,
} from '../story-progress.js';

let tempRoot;
let config;
beforeEach(() => {
  tempRoot = makeTempDir('story-progress-');
  config = { project: { paths: { tempRoot } } };
});
afterEach(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

/** A clock that advances one second per read. */
function tickingClock(startIso = '2026-10-02T10:00:00.000Z') {
  let ms = Date.parse(startIso);
  return () => {
    const at = new Date(ms);
    ms += 1000;
    return at;
  };
}

const readRecord = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

describe('storyProgressPath', () => {
  it('names the file story-progress-<id>.json in the orchestration dir', () => {
    assert.equal(
      storyProgressPath(5553, config),
      path.join(tempRoot, 'orchestration', 'story-progress-5553.json'),
    );
  });

  it('rejects a non-positive Story id like its sibling helpers', () => {
    assert.throws(() => storyProgressPath(0, config), /positive integer/);
  });

  it('AC-5: retention classifies the file as Story-keyed for its id', async () => {
    const file = storyProgressPath(5553, config);
    assert.equal(writeStoryProgress(file, { kind: STORY_PROGRESS_KIND }), true);
    const { entries, unrecognized } = await collectTempEntries({ tempRoot });
    const entry = entries.find((e) => e.path === file);
    assert.ok(entry, 'the progress file is classified');
    assert.equal(entry.className, 'orchestrationLogs');
    assert.equal(entry.storyId, 5553);
    assert.equal(unrecognized.length, 0);
  });
});

describe('writeStoryProgress', () => {
  it('AC-3: writes a tmp sibling, then renames it over the target', () => {
    const file = path.join(tempRoot, 'orchestration', 'story-progress-1.json');
    const ops = [];
    const fsImpl = {
      ...fs,
      writeFileSync: (p, ...rest) => {
        ops.push(['write', p]);
        return fs.writeFileSync(p, ...rest);
      },
      renameSync: (from, to) => {
        ops.push(['rename', from, to]);
        return fs.renameSync(from, to);
      },
    };
    assert.equal(writeStoryProgress(file, { a: 1 }, { fsImpl }), true);
    assert.deepEqual(ops, [
      ['write', `${file}.tmp`],
      ['rename', `${file}.tmp`, file],
    ]);
    assert.deepEqual(readRecord(file), { a: 1 });
    assert.equal(fs.existsSync(`${file}.tmp`), false);
  });

  it('AC-4: swallows an fs error, logs it at debug, and cleans the tmp', () => {
    const file = path.join(tempRoot, 'orchestration', 'story-progress-1.json');
    // A directory squatting on the target makes the rename fail portably.
    fs.mkdirSync(file, { recursive: true });
    const debugs = [];
    const landed = writeStoryProgress(
      file,
      { a: 1 },
      { debug: (m) => debugs.push(m) },
    );
    assert.equal(landed, false);
    assert.equal(debugs.length, 1);
    assert.match(debugs[0], /\[story-progress\] write skipped/);
    assert.equal(fs.existsSync(`${file}.tmp`), false);
  });

  it('AC-4: an unwritable orchestration folder never throws', () => {
    const blocker = path.join(tempRoot, 'orchestration');
    fs.writeFileSync(blocker, 'not a dir');
    assert.doesNotThrow(() =>
      writeStoryProgress(
        path.join(blocker, 'story-progress-1.json'),
        {},
        { debug: () => {} },
      ),
    );
  });
});

describe('createStoryProgress', () => {
  it('writes nothing until the first phase', () => {
    const rec = createStoryProgress({ storyId: 7, stage: 'close', config });
    assert.equal(rec.prNumber(12), false);
    assert.equal(fs.existsSync(rec.file), false);
  });

  it('AC-1: stageStartedAt is fixed; phaseStartedAt resets per phase; prNumber sticks', () => {
    const rec = createStoryProgress({
      storyId: 7,
      stage: 'close',
      config,
      now: tickingClock(),
    });
    rec.phase('push');
    const first = readRecord(rec.file);
    assert.equal(first.kind, 'story-progress');
    assert.equal(first.storyId, 7);
    assert.equal(first.stage, 'close');
    assert.equal(first.phase, 'push');
    assert.equal(first.prNumber, null);

    rec.phase('pull-request');
    rec.prNumber(123);
    const second = readRecord(rec.file);
    assert.equal(second.phase, 'pull-request');
    assert.equal(second.prNumber, 123);
    assert.equal(second.stageStartedAt, first.stageStartedAt);
    assert.ok(second.phaseStartedAt > first.phaseStartedAt);

    rec.phase('auto-merge');
    const third = readRecord(rec.file);
    assert.equal(third.prNumber, 123, 'the PR number survives phase changes');
    assert.equal(third.stageStartedAt, first.stageStartedAt);
    assert.ok(third.updatedAt >= third.phaseStartedAt);
  });

  it('an unparseable PR number records null', () => {
    const rec = createStoryProgress({ storyId: 7, stage: 'close', config });
    rec.phase('pull-request');
    rec.prNumber(null);
    assert.equal(readRecord(rec.file).prNumber, null);
  });

  it('AC-4: an invalid Story id degrades to a recorder that writes nothing', () => {
    const debugs = [];
    const rec = createStoryProgress({
      storyId: 0,
      stage: 'close',
      config,
      debug: (m) => debugs.push(m),
    });
    assert.equal(rec.file, null);
    assert.equal(rec.phase('push'), false);
    assert.equal(debugs.length, 1);
  });
});

describe('handoffStepName', () => {
  it('kebab-cases a step function name without its step prefix', () => {
    function stepBaseMerge() {}
    function stepCreditedRun() {}
    function stepSeat() {}
    assert.equal(handoffStepName(stepBaseMerge), 'base-merge');
    assert.equal(handoffStepName(stepCreditedRun), 'credited-run');
    assert.equal(handoffStepName(stepSeat), 'seat');
  });
});
