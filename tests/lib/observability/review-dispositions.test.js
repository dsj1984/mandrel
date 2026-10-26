/**
 * The land-time review-dispositions ledger: one record per finding id ever
 * raised, the disposition precedence, the redacted override reason, and that
 * no record carries finding content.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  readDispositions,
  recordStoryDispositions,
  summarizeDispositions,
} from '../../../.agents/scripts/lib/observability/review-dispositions.js';
import {
  appendReviewRun,
  recordOverriddenIds,
} from '../../../.agents/scripts/lib/orchestration/review-history.js';
import { findingId } from '../../../.agents/scripts/lib/orchestration/review-providers/finding-identity.js';
import { makeTempDir } from '../../../.agents/scripts/lib/test-temp.js';

function setup(t) {
  const tempRoot = makeTempDir('review-dispositions-');
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  return {
    tempRoot,
    config: { project: { paths: { tempRoot } } },
    ledger: path.join(tempRoot, 'review-dispositions.ndjson'),
  };
}

const finding = (cls, over = {}) => ({
  severity: 'high',
  provider: 'native',
  class: cls,
  title: `SECRET-TITLE ${cls}`,
  body: `SECRET-BODY ${cls}`,
  excerpt: `SECRET-EXCERPT ${cls}`,
  diff: `SECRET-DIFF ${cls}`,
  file: `src/secret-path-${cls}.js`,
  line: 4,
  ...over,
});

const now = () => '2026-10-26T00:00:00.000Z';

test('one record per finding id, each disposition by precedence', async (t) => {
  const { config, ledger } = setup(t);
  const fixed = finding('fixed', { severity: 'medium' });
  const open = finding('open');
  const ungrounded = finding('ungrounded');
  const refuted = finding('refuted');
  const overridden = finding('overridden', {
    severity: 'critical',
    provider: 'codex',
  });
  appendReviewRun(
    9,
    { headSha: 'a', findings: [fixed, open, overridden] },
    { config },
  );
  appendReviewRun(
    9,
    {
      headSha: 'b',
      findings: [
        open,
        { ...overridden, ungrounded: 'overridden earlier' },
        { ...ungrounded, ungrounded: 'no such line' },
        { ...refuted, unverified: 'verifier refuted' },
      ],
    },
    { config },
  );
  const token = `ghp_${'a'.repeat(30)}`;
  recordOverriddenIds(9, [findingId(overridden)], {
    config,
    reason: `false positive ${token} ${'x'.repeat(600)}`,
  });

  const out = await recordStoryDispositions({ storyId: 9, config, now });
  assert.equal(out.appended, 5);
  const records = fs
    .readFileSync(ledger, 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
  const by = Object.fromEntries(records.map((r) => [r.findingId, r]));
  assert.equal(records.length, 5);
  assert.equal(by[findingId(fixed)].disposition, 'fixed-on-branch');
  assert.equal(by[findingId(fixed)].severity, 'medium');
  assert.equal(by[findingId(fixed)].runs, 1);
  assert.equal(by[findingId(open)].disposition, 'open-at-merge');
  assert.equal(by[findingId(open)].runs, 2);
  assert.equal(by[findingId(ungrounded)].disposition, 'downgraded-ungrounded');
  assert.equal(by[findingId(refuted)].disposition, 'refuted-by-verifier');
  const o = by[findingId(overridden)];
  assert.deepEqual(
    { d: o.disposition, s: o.severity, p: o.provider, c: o.class },
    { d: 'overridden', s: 'critical', p: 'codex', c: 'overridden' },
  );
  assert.ok(o.reason.length <= 500);
  assert.ok(!o.reason.includes(token));
  assert.match(o.reason, /\[REDACTED\]/);
  for (const r of records) {
    assert.equal(r.v, 1);
    assert.equal(r.storyId, 9);
    assert.equal(r.ts, now());
    if (r.disposition !== 'overridden') assert.equal('reason' in r, false);
  }
  assert.doesNotMatch(
    fs.readFileSync(ledger, 'utf8'),
    /SECRET|secret-path|src\//,
  );
});

test('idempotent per Story; no history appends nothing', async (t) => {
  const { config, ledger } = setup(t);
  appendReviewRun(3, { headSha: 'a', findings: [finding('x')] }, { config });
  assert.equal(
    (await recordStoryDispositions({ storyId: 3, config, now })).appended,
    1,
  );
  const again = await recordStoryDispositions({ storyId: 3, config, now });
  assert.deepEqual(again, {
    ok: true,
    appended: 0,
    detail: 'already recorded',
  });
  assert.equal(fs.readFileSync(ledger, 'utf8').trim().split('\n').length, 1);
  const none = await recordStoryDispositions({ storyId: 4, config, now });
  assert.equal(none.appended, 0);
});

test('an override recorded without a reason omits it', async (t) => {
  const { config } = setup(t);
  const f = finding('c', { severity: 'critical' });
  appendReviewRun(5, { headSha: 'a', findings: [f] }, { config });
  recordOverriddenIds(5, [findingId(f)], { config });
  await recordStoryDispositions({ storyId: 5, config, now });
  const [r] = await readDispositions({ config });
  assert.equal(r.disposition, 'overridden');
  assert.equal('reason' in r, false);
});

test('readDispositions filters by --since and includes the rotated generation', async (t) => {
  const { config, ledger } = setup(t);
  fs.writeFileSync(
    `${ledger}.1`,
    `${JSON.stringify({ ts: '2026-01-01T00:00:00Z', storyId: 1 })}\n`,
  );
  fs.writeFileSync(
    ledger,
    `${JSON.stringify({ ts: '2026-10-01T00:00:00Z', storyId: 2 })}\nnot json\n`,
  );
  assert.equal((await readDispositions({ config })).length, 2);
  const recent = await readDispositions({ config, since: '2026-06-01' });
  assert.deepEqual(
    recent.map((r) => r.storyId),
    [2],
  );
});

test('summarizeDispositions: rates, precision and false-blocker proxies', () => {
  const rec = (provider, severity, disposition) => ({
    provider,
    severity,
    disposition,
  });
  const s = summarizeDispositions([
    rec('native', 'critical', 'overridden'),
    rec('native', 'critical', 'open-at-merge'),
    rec('codex', 'high', 'fixed-on-branch'),
    rec('codex', 'medium', 'refuted-by-verifier'),
  ]);
  assert.equal(s.overall.total, 4);
  assert.equal(s.overall.precision, 0.5);
  assert.equal(s.overall.falseBlocker, 0.5);
  assert.equal(s.byProvider.native.counts.overridden, 1);
  assert.equal(s.byProvider.codex.falseBlocker, null);
  assert.equal(s.bySeverity.critical.rates['open-at-merge'], 0.5);
});

test('the ledger rotates to one .1 generation at 1 MB', async (t) => {
  const { config, ledger } = setup(t);
  const line = `${JSON.stringify({ storyId: 1, pad: 'p'.repeat(1000) })}\n`;
  fs.writeFileSync(ledger, line.repeat(Math.ceil((1024 * 1024) / line.length)));
  appendReviewRun(6, { headSha: 'a', findings: [finding('r')] }, { config });
  await recordStoryDispositions({ storyId: 6, config, now });
  assert.ok(fs.existsSync(`${ledger}.1`));
  assert.equal(fs.readFileSync(ledger, 'utf8').trim().split('\n').length, 1);
});
