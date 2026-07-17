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
 *
 * Every event here has a live emitter. Story #4545 pruned the entries whose
 * emitters were deleted with the Epic-orchestration stratum (all
 * `acceptance.reconcile.*`, plus the `epic.automerge.*` / `epic.cleanup.*` /
 * `epic.close.*` / `epic.complete` / `epic.finalize.*` / `epic.merge.*` /
 * `epic.blocked` / `epic.plan.*` / `epic.snapshot.*` families) — their schema
 * files went with them. The `epic.watch.*` pair followed later: the only
 * production Watcher consumer (`pr-watch-with-update.js`) runs without a
 * bus, so the emits (and schemas) were dead.
 *
 * Adding a new event here without adding the matching schema file fails this
 * test — that's the point. The bus reads the schema by name at emit time.
 * `ledger-record` is deliberately absent: it is the ledger envelope, not an
 * event, and is asserted separately below.
 */
const REQUIRED_EVENTS = Object.freeze([
  'checkpoint.written',
  'close-validate.end',
  'close-validate.start',
  'code-review.end',
  'code-review.start',
  'intervention.recorded',
  'loop.tick',
  'merge.flip-failed',
  'merge.unlanded',
  'notification.emitted',
  'pr.created',
  'retro.end',
  'retro.start',
  'story.blocked',
  'story.dispatch.end',
  'story.dispatch.start',
  'story.merged',
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
      event: 'story.dispatch.start',
      payload: { storyId: 2172, waveIndex: 0 },
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
      event: 'story.dispatch.start',
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
      event: 'story.dispatch.start',
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
      event: 'story.dispatch.start',
    });
    assert.equal(ok, false);
  });

  it('agentrc.schema rejects retired delivery.lifecycle keys', () => {
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
            'story.dispatch.start': 30,
            'code-review.start': 600,
          },
          heartbeatWarnSeconds: 60,
        },
      },
    });
    assert.equal(ok, false);
  });

  it('agentrc.schema accepts delivery.mergeWatch.intervalSeconds and maxBudgetSeconds', () => {
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
        mergeWatch: { intervalSeconds: 60, maxBudgetSeconds: 7200 },
      },
    });
    assert.equal(ok, true, JSON.stringify(validate.errors));
  });

  it('agentrc.schema rejects non-integer delivery.mergeWatch.intervalSeconds', () => {
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
        mergeWatch: { intervalSeconds: 1.5 },
      },
    });
    assert.equal(ok, false);
  });

  it('agentrc.schema rejects negative delivery.mergeWatch.intervalSeconds', () => {
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
        mergeWatch: { intervalSeconds: -1 },
      },
    });
    assert.equal(ok, false);
  });

  it('agentrc.schema rejects unknown delivery.mergeWatch key', () => {
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
        mergeWatch: { bogus: true },
      },
    });
    assert.equal(ok, false);
  });
});
