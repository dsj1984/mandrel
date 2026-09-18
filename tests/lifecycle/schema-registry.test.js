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
 * The lifecycle events that MUST have a schema file in
 * `.agents/schemas/lifecycle/`.
 *
 * **A schema earns its place only while code emits it** — the rule
 * `docs/LIFECYCLE.md` states and Story #4545 applied when it pruned the
 * `epic.*` / `acceptance.reconcile.*` families. Story #5024 applied it to the
 * rest: retiring the lifecycle bus left `appendLedgerEvent` (a bare
 * `appendFileSync` from the `single-story-close` flow) as the only producer of
 * any lifecycle record, and it writes exactly these two events. Fifteen
 * schemas whose emitters had gone with the Epic-orchestration stratum went
 * with the bus.
 *
 * This list is checked in BOTH directions below. The one-way version pinned
 * the dead schemas in place: it asserted every listed event had a file while
 * its own comment claimed "every event here has a live emitter" — a claim
 * nothing verified, and false for 15 of 17 by the time #5024 measured it. An
 * orphan schema file now fails too, so a deleted emitter cannot leave its
 * schema behind.
 *
 * `ledger-record` is deliberately absent: it is the ledger envelope, not an
 * event, and is asserted separately below.
 */
const REQUIRED_EVENTS = Object.freeze(['merge.flip-failed', 'merge.unlanded']);

function readSchema(name) {
  return JSON.parse(
    readFileSync(path.join(SCHEMA_DIR, `${name}.schema.json`), 'utf8'),
  );
}

describe('lifecycle/schema-registry', () => {
  it('every required event has a schema file', () => {
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

  it('ships no schema file for an event nobody emits', () => {
    // The direction the one-way assertion missed: a schema whose emitter was
    // deleted used to sit here reading green forever. `ledger-record` is the
    // envelope, not an event, so it is the one permitted extra.
    const allowed = new Set([...REQUIRED_EVENTS, 'ledger-record']);
    const orphans = readdirSync(SCHEMA_DIR)
      .filter((f) => f.endsWith('.schema.json'))
      .map((f) => f.replace(/\.schema\.json$/, ''))
      .filter((event) => !allowed.has(event));
    assert.deepEqual(
      orphans,
      [],
      `schema file(s) with no emitter in REQUIRED_EVENTS: ${orphans.join(', ')}`,
    );
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
      event: 'merge.unlanded',
      payload: { storyId: 5024, blockClass: 'checks-failed' },
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
      event: 'merge.unlanded',
      listener: 'ArchivedListener',
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
      event: 'merge.unlanded',
      listener: 'ArchivedListener',
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
      event: 'merge.unlanded',
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

  it('agentrc.schema accepts delivery.mergeWatch.maxBudgetSeconds', () => {
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
        mergeWatch: { maxBudgetSeconds: 7200 },
      },
    });
    assert.equal(ok, true, JSON.stringify(validate.errors));
  });

  it('agentrc.schema rejects the folded delivery.mergeWatch.intervalSeconds (Story #5382)', () => {
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

  it('agentrc.schema rejects negative delivery.mergeWatch.maxBudgetSeconds', () => {
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
        mergeWatch: { maxBudgetSeconds: -1 },
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
