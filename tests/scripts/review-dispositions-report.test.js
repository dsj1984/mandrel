/**
 * review-dispositions-report.js: counts and rates per provider and severity,
 * `--json`, `--since`, and a clean exit on an empty ledger.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { makeTempDir } from '../../.agents/scripts/lib/test-temp.js';
import { runReviewDispositionsReport } from '../../.agents/scripts/review-dispositions-report.js';

const SCRIPT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '.agents',
  'scripts',
  'review-dispositions-report.js',
);

function setup(t, records = []) {
  const tempRoot = makeTempDir('review-dispositions-report-');
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  if (records.length > 0) {
    fs.writeFileSync(
      path.join(tempRoot, 'review-dispositions.ndjson'),
      records.map((r) => `${JSON.stringify(r)}\n`).join(''),
    );
  }
  let out = '';
  return {
    deps: {
      resolveConfigImpl: () => ({ project: { paths: { tempRoot } } }),
      stdout: { write: (s) => (out += s) },
    },
    out: () => out,
  };
}

const rec = (ts, provider, severity, disposition) => ({
  v: 1,
  ts,
  storyId: 1,
  findingId: 'abc',
  provider,
  severity,
  disposition,
  runs: 1,
});

const RECORDS = [
  rec('2026-09-01T00:00:00Z', 'native', 'critical', 'overridden'),
  rec('2026-10-02T00:00:00Z', 'native', 'high', 'fixed-on-branch'),
  rec('2026-10-03T00:00:00Z', 'codex', 'critical', 'open-at-merge'),
];

test('prints counts and rates per provider and per severity', async (t) => {
  const { deps, out } = setup(t, RECORDS);
  await runReviewDispositionsReport([], deps);
  assert.match(out(), /^provider\s+total/m);
  assert.match(out(), /^native\s+2\s+1 \(50\.0%\)/m);
  assert.match(out(), /^severity\s+total/m);
  assert.match(out(), /^critical\s+2/m);
});

test('--json emits the summary; --since filters it', async (t) => {
  const { deps, out } = setup(t, RECORDS);
  await runReviewDispositionsReport(['--json', '--since', '2026-10-01'], deps);
  const summary = JSON.parse(out());
  assert.equal(summary.overall.total, 2);
  assert.equal(summary.overall.precision, 1);
  assert.equal(summary.overall.falseBlocker, 0);
  assert.deepEqual(Object.keys(summary.byProvider), ['codex', 'native']);
});

test('an empty or absent ledger prints the no-dispositions line', async (t) => {
  const { deps, out } = setup(t);
  assert.equal(await runReviewDispositionsReport([], deps), null);
  assert.match(out(), /no dispositions recorded/);
});

test('rejects a malformed --since', async (t) => {
  const { deps } = setup(t);
  await assert.rejects(
    runReviewDispositionsReport(['--since', 'yesterday'], deps),
    /YYYY-MM-DD/,
  );
});

test('--help prints usage and exits 0', () => {
  const run = spawnSync(process.execPath, [SCRIPT, '--help'], {
    encoding: 'utf8',
  });
  assert.equal(run.status, 0);
  assert.match(run.stdout, /review-dispositions-report\.js \[--since/);
});
