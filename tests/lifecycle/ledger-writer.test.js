// tests/lifecycle/ledger-writer.test.js
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { Bus } from '../../.agents/scripts/lib/orchestration/lifecycle/bus.js';
import {
  LedgerWriter,
  SECRET_KEY_DENY_LIST,
  stripSecrets,
} from '../../.agents/scripts/lib/orchestration/lifecycle/ledger-writer.js';

function readNdjson(p) {
  return readFileSync(p, 'utf8')
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l));
}

describe('lifecycle/ledger-writer', () => {
  let tempRoot;

  beforeEach(() => {
    tempRoot = mkdtempSync(path.join(tmpdir(), 'mandrel-ledger-'));
  });
  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('stripSecrets removes deny-listed keys at every depth', () => {
    const dirty = {
      epicId: 1,
      token: 'leak-1',
      nested: {
        password: 'leak-2',
        keep: 'me',
        deeper: { apiKey: 'leak-3', alsoKeep: 7 },
      },
      list: [{ secret: 'leak-4', label: 'one' }],
    };
    const clean = stripSecrets(dirty);
    assert.deepEqual(clean, {
      epicId: 1,
      nested: { keep: 'me', deeper: { alsoKeep: 7 } },
      list: [{ label: 'one' }],
    });
    // Input not mutated.
    assert.equal(dirty.token, 'leak-1');
  });

  it('SECRET_KEY_DENY_LIST is the canonical static list', () => {
    assert.deepEqual(
      [...SECRET_KEY_DENY_LIST],
      ['token', 'password', 'secret', 'apikey', 'webhookurl'],
    );
  });

  it('LedgerWriter emits exactly one emitted + one completed per successful emit, in order', async () => {
    const bus = new Bus();
    const writer = new LedgerWriter({ epicId: 42, tempRoot });
    writer.register(bus);
    bus.on('epic.snapshot.start', () => {});
    await bus.emit('epic.snapshot.start', { epicId: 42 });
    const records = readNdjson(writer.ledgerPath);
    assert.equal(records.length, 2);
    assert.equal(records[0].kind, 'emitted');
    assert.equal(records[0].seqId, 1);
    assert.equal(records[0].event, 'epic.snapshot.start');
    assert.deepEqual(records[0].payload, { epicId: 42 });
    assert.equal(records[1].kind, 'completed');
    assert.equal(records[1].seqId, 1);
    assert.equal(records[1].event, 'epic.snapshot.start');
  });

  it('Ledger entries omit keys named in SECRET_KEY_DENY_LIST', async () => {
    const bus = new Bus();
    const writer = new LedgerWriter({ epicId: 7, tempRoot });
    writer.register(bus);
    // notification.emitted has schema { event, channel, severity, ok };
    // additionalProperties is false so we'd fail validation if we added
    // a `token` key at the top level. So we test stripping via a payload
    // that the schema permits to carry an extra nested-object key —
    // namely use story.merged with a sha that we'll leave clean, but
    // assert the strip function fires by passing a token through the
    // payload of an event whose schema is permissive. Use the unit test
    // on stripSecrets above for nested keys; here, assert the writer's
    // record builder strips the top-level deny-listed key directly.
    const record = writer.buildEmitted({
      event: 'epic.snapshot.start',
      seqId: 1,
      payload: { epicId: 1, token: 'leak', nested: { secret: 'leak2' } },
    });
    assert.deepEqual(record.payload, { epicId: 1, nested: {} });
  });

  it('writes a failed record + propagates the throw when a listener throws', async () => {
    const bus = new Bus();
    const writer = new LedgerWriter({ epicId: 7, tempRoot });
    writer.register(bus);
    bus.on('epic.snapshot.start', () => {
      const err = new Error('boom');
      err.listener = 'TestListener';
      throw err;
    });
    await assert.rejects(() => bus.emit('epic.snapshot.start', { epicId: 7 }), {
      message: 'boom',
    });
    const records = readNdjson(writer.ledgerPath);
    assert.equal(records.length, 2);
    assert.equal(records[0].kind, 'emitted');
    assert.equal(records[1].kind, 'failed');
    assert.equal(records[1].listener, 'TestListener');
    assert.equal(records[1].error.message, 'boom');
  });

  it('does NOT write an emitted record when schema validation fails', async () => {
    const bus = new Bus();
    const writer = new LedgerWriter({ epicId: 13, tempRoot });
    writer.register(bus);
    await assert.rejects(
      () => bus.emit('epic.snapshot.start', { wrong: 'shape' }),
      { code: 'BUS_SCHEMA_VALIDATION' },
    );
    // ledger file should not exist yet — nothing was emitted.
    assert.throws(() => readNdjson(writer.ledgerPath), { code: 'ENOENT' });
  });

  it('seqId is monotonic across multiple successful emits', async () => {
    const bus = new Bus();
    const writer = new LedgerWriter({ epicId: 9, tempRoot });
    writer.register(bus);
    bus.on('epic.snapshot.start', () => {});
    bus.on('epic.snapshot.end', () => {});
    await bus.emit('epic.snapshot.start', { epicId: 9 });
    await bus.emit('epic.snapshot.end', { epicId: 9, storyIds: [1] });
    await bus.emit('epic.snapshot.start', { epicId: 9 });
    const records = readNdjson(writer.ledgerPath);
    const emitted = records.filter((r) => r.kind === 'emitted');
    assert.deepEqual(
      emitted.map((r) => r.seqId),
      [1, 2, 3],
    );
  });

  it('rejects invalid constructor opts', () => {
    assert.throws(
      () => new LedgerWriter({ epicId: 0, tempRoot: 'x' }),
      TypeError,
    );
    assert.throws(() => new LedgerWriter({ epicId: 1 }), TypeError);
    assert.throws(() => new LedgerWriter({ tempRoot: 'x' }), TypeError);
  });

  it('register() rejects a bus that lacks the privileged hook surface', () => {
    const writer = new LedgerWriter({ epicId: 1, tempRoot });
    assert.throws(() => writer.register({}), TypeError);
    assert.throws(() => writer.register({ emit: () => {} }), TypeError);
  });
});
