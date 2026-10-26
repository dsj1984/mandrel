/**
 * Unit tests for `review-history.js` and `finding-identity.js`: the per-Story
 * review history, the stable finding id, and repeat marking.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  appendReviewRun,
  markRepeats,
  readReviewHistory,
  recordOverriddenIds,
} from '../../../.agents/scripts/lib/orchestration/review-history.js';
import { findingId } from '../../../.agents/scripts/lib/orchestration/review-providers/finding-identity.js';

function deps(t) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'review-history-'));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  return { tempRoot, config: { project: { paths: { tempRoot } } } };
}

const finding = (over = {}) => ({
  severity: 'critical',
  title: 'Retry loop has no bound on 3 calls',
  body: 'b',
  file: 'src/a.js',
  line: 10,
  ...over,
});

test('findingId: 12 hex chars, stable across line moves and digits in the title', () => {
  const id = findingId(finding());
  assert.match(id, /^[0-9a-f]{12}$/);
  assert.equal(findingId(finding({ line: 400 })), id);
  assert.equal(
    findingId(finding({ title: '  Retry loop has NO bound on 7 calls ' })),
    id,
  );
  assert.notEqual(findingId(finding({ file: 'src/b.js' })), id);
  assert.notEqual(findingId(finding({ title: 'Other defect' })), id);
});

test('findingId: a classed finding ignores its title and keys on the first instance file', () => {
  const a = finding({ class: 'unbounded-retry', title: 'one' });
  const b = finding({
    class: 'unbounded-retry',
    title: 'two',
    instances: [{ file: 'src/a.js', line: 3 }, { file: 'src/z.js' }],
  });
  assert.equal(findingId(a), findingId(b));
  assert.notEqual(findingId(a), findingId(finding({ category: 'bug' })));
});

test('readReviewHistory: absent or malformed history reads as empty', (t) => {
  const { config, tempRoot } = deps(t);
  assert.deepEqual(readReviewHistory(7, { config }), {
    runs: [],
    overridden: [],
  });
  const dir = path.join(tempRoot, 'orchestration');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'story-review-history-7.json'), '{oops');
  assert.deepEqual(readReviewHistory(7, { config }).runs, []);
});

test('appendReviewRun and recordOverriddenIds write one history beside the deposit, keyed to the Story', (t) => {
  const { config, tempRoot } = deps(t);
  const f = finding({
    class: 'unbounded-retry',
    provider: 'code-review',
    unverified: 'refuted',
    instances: [{ file: 'src/a.js', line: 10 }, { file: 'src/b.js' }],
  });
  appendReviewRun(7, { headSha: 'abc', findings: [f] }, { config });
  appendReviewRun(7, { headSha: 'def', findings: [] }, { config });
  recordOverriddenIds(7, [findingId(f), findingId(f)], { config });
  const file = path.join(
    tempRoot,
    'orchestration',
    'story-review-history-7.json',
  );
  const record = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(record.kind, 'story-review-history');
  assert.equal(record.storyId, 7);
  assert.deepEqual(
    record.runs.map((r) => r.headSha),
    ['abc', 'def'],
  );
  assert.deepEqual(record.runs[0].findings[0], {
    id: findingId(f),
    severity: 'critical',
    provider: 'code-review',
    class: 'unbounded-retry',
    instances: [{ file: 'src/a.js', line: 10 }, { file: 'src/b.js' }],
    unverified: 'refuted',
  });
  assert.deepEqual(record.overridden, [findingId(f)]);
});

test('markRepeats: same id within ±10 lines is a repeat; further away or another id is not', () => {
  const earlier = finding();
  const history = {
    runs: [
      {
        headSha: 'a',
        findings: [
          {
            id: findingId(earlier),
            instances: [{ file: 'src/a.js', line: 10 }],
          },
        ],
      },
    ],
    overridden: [],
  };
  const [near, far, other] = markRepeats(
    [
      finding({ line: 20 }),
      finding({ line: 21 }),
      finding({ title: 'Different' }),
    ],
    history,
  );
  assert.equal(near.repeat, true);
  assert.equal(near.severity, 'critical');
  assert.ok(!far.repeat);
  assert.ok(!other.repeat);
});

test('markRepeats: both lineless in the same file is a repeat; one lineless side is not', () => {
  const lineless = finding({ line: undefined });
  const history = {
    runs: [
      {
        headSha: 'a',
        findings: [
          { id: findingId(lineless), instances: [{ file: 'src/a.js' }] },
        ],
      },
    ],
    overridden: [],
  };
  const [same, lined] = markRepeats([lineless, finding()], history);
  assert.equal(same.repeat, true);
  assert.ok(!lined.repeat);
});

test('markRepeats: a repeat of an overridden CRITICAL is downgraded; a fresh one is not', () => {
  const f = finding();
  const id = findingId(f);
  const history = {
    runs: [
      {
        headSha: 'a',
        findings: [{ id, instances: [{ file: 'src/a.js', line: 12 }] }],
      },
    ],
    overridden: [id],
  };
  const [repeat] = markRepeats([f], history);
  assert.equal(repeat.severity, 'suggestion');
  assert.equal(repeat.ungrounded, 'overridden earlier');
  assert.equal(repeat.repeat, true);
  const [fresh] = markRepeats([f], { runs: [], overridden: [id] });
  assert.equal(fresh.severity, 'critical');
});
