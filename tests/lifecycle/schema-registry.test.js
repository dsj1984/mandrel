// tests/lifecycle/schema-registry.test.js
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

import { AGENTRC_SCHEMA } from '../../.agents/scripts/lib/config-settings-schema.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_DIR = path.resolve(
  __dirname,
  '..',
  '..',
  '.agents',
  'schemas',
  'lifecycle',
);

/**
 * Event taxonomy that MUST have a schema file in `.agents/schemas/lifecycle/`.
 * Source: Tech Spec #2189 § Data Models / Event taxonomy.
 *
 * Adding a new event here without adding the matching schema file fails this
 * test — that's the point. The bus reads the schema by name at emit time.
 */
const REQUIRED_EVENTS = Object.freeze([
  'epic.snapshot.start',
  'epic.snapshot.end',
  'epic.plan.start',
  'epic.plan.end',
  'wave.start',
  'wave.end',
  'story.dispatch.start',
  'story.dispatch.end',
  'story.merged',
  'story.blocked',
  'epic.blocked',
  'epic.unblocked',
  'epic.close.start',
  'epic.close.end',
  'acceptance.reconcile.start',
  'acceptance.reconcile.ok',
  'acceptance.reconcile.skipped',
  'acceptance.reconcile.failed',
  'epic.finalize.start',
  'epic.finalize.end',
  'pr.created',
  'epic.watch.start',
  'epic.watch.end',
  'epic.automerge.start',
  'epic.automerge.end',
  'epic.merge.ready',
  'epic.merge.blocked',
  'epic.merge.armed',
  'epic.cleanup.start',
  'epic.cleanup.end',
  'epic.complete',
  'notification.emitted',
  'checkpoint.written',
]);

function readSchema(name) {
  return JSON.parse(
    readFileSync(path.join(SCHEMA_DIR, `${name}.schema.json`), 'utf8'),
  );
}

describe('lifecycle/schema-registry', () => {
  it('every event in the Tech Spec taxonomy has a schema file', () => {
    const files = new Set(
      readdirSync(SCHEMA_DIR).filter((f) => f.endsWith('.schema.json')),
    );
    for (const event of REQUIRED_EVENTS) {
      assert.ok(
        files.has(`${event}.schema.json`),
        `missing schema for event "${event}" (expected ${event}.schema.json)`,
      );
    }
  });

  it('every event schema compiles under AJV draft 2020-12', () => {
    const ajv = new Ajv2020({ allErrors: true });
    addFormats(ajv);
    for (const event of REQUIRED_EVENTS) {
      const schema = readSchema(event);
      assert.doesNotThrow(
        () => ajv.compile(schema),
        `schema for "${event}" failed to compile`,
      );
    }
  });

  it('ledger-record schema validates a sample emitted record', () => {
    const ajv = new Ajv2020({ allErrors: true });
    addFormats(ajv);
    const validate = ajv.compile(readSchema('ledger-record'));
    const ok = validate({
      kind: 'emitted',
      seqId: 1,
      ts: '2026-05-17T10:00:00.000Z',
      event: 'epic.snapshot.start',
      payload: { epicId: 2172 },
    });
    assert.equal(ok, true, JSON.stringify(validate.errors));
  });

  it('ledger-record schema validates a sample completed record', () => {
    const ajv = new Ajv2020({ allErrors: true });
    addFormats(ajv);
    const validate = ajv.compile(readSchema('ledger-record'));
    const ok = validate({
      kind: 'completed',
      seqId: 1,
      ts: '2026-05-17T10:00:00.001Z',
      event: 'epic.snapshot.start',
      listener: 'LedgerWriter',
    });
    assert.equal(ok, true, JSON.stringify(validate.errors));
  });

  it('ledger-record schema validates a sample failed record', () => {
    const ajv = new Ajv2020({ allErrors: true });
    addFormats(ajv);
    const validate = ajv.compile(readSchema('ledger-record'));
    const ok = validate({
      kind: 'failed',
      seqId: 1,
      ts: '2026-05-17T10:00:00.002Z',
      event: 'epic.snapshot.start',
      listener: 'LedgerWriter',
      error: { name: 'Error', message: 'boom' },
    });
    assert.equal(ok, true, JSON.stringify(validate.errors));
  });

  it('ledger-record schema rejects an unknown kind', () => {
    const ajv = new Ajv2020({ allErrors: true });
    addFormats(ajv);
    const validate = ajv.compile(readSchema('ledger-record'));
    const ok = validate({
      kind: 'unknown',
      seqId: 1,
      ts: '2026-05-17T10:00:00.000Z',
      event: 'epic.snapshot.start',
    });
    assert.equal(ok, false);
  });

  it('wave.end schema accepts a balanced outcomes object', () => {
    const ajv = new Ajv2020({ allErrors: true });
    addFormats(ajv);
    const validate = ajv.compile(readSchema('wave.end'));
    const ok = validate({
      waveIndex: 0,
      outcomes: { 2227: 'done', 2228: 'blocked' },
    });
    assert.equal(ok, true, JSON.stringify(validate.errors));
  });

  it('agentrc.schema accepts new delivery.lifecycle keys', () => {
    const ajv = new Ajv2020({ allErrors: true });
    addFormats(ajv);
    const validate = ajv.compile(AGENTRC_SCHEMA);
    const ok = validate({
      project: {
        paths: {
          agentRoot: '.agents',
          docsRoot: 'docs',
          tempRoot: 'temp',
        },
      },
      delivery: {
        lifecycle: {
          timeouts: {
            'epic.snapshot.start': 30,
            'epic.finalize.start': 600,
          },
          heartbeatWarnSeconds: 60,
        },
      },
    });
    assert.equal(ok, true, JSON.stringify(validate.errors));
  });

  it('agentrc.schema rejects unknown delivery.lifecycle key', () => {
    const ajv = new Ajv2020({ allErrors: true });
    addFormats(ajv);
    const validate = ajv.compile(AGENTRC_SCHEMA);
    const ok = validate({
      project: {
        paths: {
          agentRoot: '.agents',
          docsRoot: 'docs',
          tempRoot: 'temp',
        },
      },
      delivery: {
        lifecycle: { bogus: true },
      },
    });
    assert.equal(ok, false);
  });
});
