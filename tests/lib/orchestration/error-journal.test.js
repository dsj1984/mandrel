import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ErrorJournal } from '../../../.agents/scripts/lib/orchestration/error-journal.js';

async function makeTmp() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'error-journal-'));
}

async function readJournal(p) {
  const raw = await fs.readFile(p, 'utf8');
  return raw
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

test('ErrorJournal: rejects non-integer epicId', () => {
  assert.throws(() => new ErrorJournal({ epicId: 'abc' }), TypeError);
  assert.throws(() => new ErrorJournal({}), TypeError);
});

test('ErrorJournal: path getter produces epic-<id>-errors.log under logDir', async () => {
  const dir = await makeTmp();
  const j = new ErrorJournal({ epicId: 42, logDir: dir });
  assert.equal(j.path, path.join(dir, 'epic-42-errors.log'));
});

test('ErrorJournal: record writes one JSONL line with expected shape', async () => {
  const dir = await makeTmp();
  const j = new ErrorJournal({ epicId: 1, logDir: dir });
  await j.record({
    module: 'BlockerHandler',
    op: 'postComment',
    error: new Error('boom'),
    recovery: 'swallowed',
  });
  await j.finalize();
  const lines = await readJournal(j.path);
  assert.equal(lines.length, 1);
  const entry = lines[0];
  assert.equal(entry.epicId, 1);
  assert.equal(entry.module, 'BlockerHandler');
  assert.equal(entry.op, 'postComment');
  assert.equal(entry.error.message, 'boom');
  assert.equal(entry.error.name, 'Error');
  assert.equal(entry.recovery, 'swallowed');
  assert.match(entry.ts, /^\d{4}-\d{2}-\d{2}T/);
});

test('ErrorJournal: lazy open — no file created until first record', async () => {
  const dir = await makeTmp();
  const j = new ErrorJournal({ epicId: 2, logDir: dir });
  await j.finalize();
  await assert.rejects(() => fs.access(j.path), { code: 'ENOENT' });
});

test('ErrorJournal: append-only across multiple records', async () => {
  const dir = await makeTmp();
  const j = new ErrorJournal({ epicId: 3, logDir: dir });
  await j.record({ module: 'A', op: 'one', error: 'first' });
  await j.record({ module: 'B', op: 'two', error: 'second' });
  await j.finalize();
  const lines = await readJournal(j.path);
  assert.equal(lines.length, 2);
  assert.equal(lines[0].error.message, 'first');
  assert.equal(lines[1].error.message, 'second');
});

test('ErrorJournal: finalize is idempotent and drops subsequent records', async () => {
  const dir = await makeTmp();
  const j = new ErrorJournal({ epicId: 4, logDir: dir });
  await j.record({ module: 'A', op: 'one', error: 'kept' });
  await j.finalize();
  await j.finalize(); // repeat is fine
  await j.record({ module: 'A', op: 'two', error: 'dropped' });
  const lines = await readJournal(j.path);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].error.message, 'kept');
});

test('ErrorJournal: emits ::add-mask:: for values under secret-like keys', async () => {
  const dir = await makeTmp();
  const j = new ErrorJournal({ epicId: 5, logDir: dir });
  const originalLog = console.log;
  const lines = [];
  console.log = (msg) => lines.push(String(msg));
  try {
    await j.record({
      module: 'X',
      op: 'y',
      error: { message: 'hi', token: 'super-secret-value-123' },
    });
  } finally {
    console.log = originalLog;
    await j.finalize();
  }
  assert.ok(
    lines.some((l) => l === '::add-mask::super-secret-value-123'),
    `expected mask directive, got:\n${lines.join('\n')}`,
  );
});

test('ErrorJournal: emits ::add-mask:: for values that look like GitHub tokens', async () => {
  const dir = await makeTmp();
  const j = new ErrorJournal({ epicId: 6, logDir: dir });
  const originalLog = console.log;
  const lines = [];
  console.log = (msg) => lines.push(String(msg));
  try {
    const fake = `ghp_${'a'.repeat(36)}`;
    await j.record({
      module: 'X',
      op: 'y',
      error: new Error(`auth failed with ${fake}`),
    });
  } finally {
    console.log = originalLog;
    await j.finalize();
  }
  assert.ok(
    lines.some((l) => l.startsWith('::add-mask::') && l.includes('ghp_')),
    `expected mask directive, got:\n${lines.join('\n')}`,
  );
});

test('ErrorJournal: no mask emitted for mundane values', async () => {
  const dir = await makeTmp();
  const j = new ErrorJournal({ epicId: 7, logDir: dir });
  const originalLog = console.log;
  const lines = [];
  console.log = (msg) => lines.push(String(msg));
  try {
    await j.record({
      module: 'BlockerHandler',
      op: 'postComment',
      error: new Error('HTTP 500'),
      recovery: 'swallowed',
    });
  } finally {
    console.log = originalLog;
    await j.finalize();
  }
  assert.equal(lines.filter((l) => l.startsWith('::add-mask::')).length, 0);
});

test('ErrorJournal: integration — blocker-wait labelFetcher failure produces expected entry', async () => {
  // Story #2241 / Task #2246 — the legacy BlockerHandler was split into a
  // lifecycle listener (classification + cascade emit) and a thin
  // wait-for-resume helper. The error-journal integration now lives in
  // the wait helper, which records labelFetcher failures as
  // `module: 'BlockerWait'` so the operator can trace a hung resume to
  // a provider blip without grepping through the lifecycle ledger.
  const { waitForEpicUnblock } = await import(
    '../../../.agents/scripts/lib/orchestration/epic-runner/blocker-wait.js'
  );
  const dir = await makeTmp();
  const journal = new ErrorJournal({ epicId: 99, logDir: dir });
  let polls = 0;
  const labelFetcher = async () => {
    polls += 1;
    if (polls === 1) {
      throw new Error('rate-limited');
    }
    // Second poll observes the operator's flip back to executing so the
    // wait helper resolves immediately after the journaled failure.
    return ['agent::executing'];
  };
  await waitForEpicUnblock({
    epicId: 99,
    labelFetcher,
    pollIntervalMs: 1,
    errorJournal: journal,
    logger: { info: () => {}, warn: () => {}, debug: () => {} },
  });
  await journal.finalize();

  const lines = await readJournal(journal.path);
  const entry = lines.find(
    (l) => l.op === 'labelFetcher' && l.module === 'BlockerWait',
  );
  assert.ok(
    entry,
    `expected BlockerWait entry; got:\n${JSON.stringify(lines, null, 2)}`,
  );
  assert.equal(entry.error.message, 'rate-limited');
  assert.equal(entry.recovery, 'returned-empty');
  assert.equal(entry.epicId, 99);
});
