/**
 * Contract tests for `.agents/schemas/qa-ledger.schema.json`.
 *
 * Story #3716 (Feature #3710 "f3-qa-explore-core", Epic #3686). The
 * exploratory-QA ledger turns observations captured while exploring a consumer
 * surface into structured ledger items; this schema is the contract those
 * items are validated against before Triage parses a session. The ledger is
 * deliberately a distinct artifact from the browser-sweep `qa-finding`, so it
 * carries its own title and `$id`.
 *
 * Verifies:
 *   1. The schema exists, parses, declares draft-07, and compiles under AJV.
 *   2. A valid ledger item carrying id, class, severity, evidence, coverage,
 *      missingTest, disposition, and relates round-trips cleanly.
 *   3. A ledger item whose class is outside the enum is rejected.
 *   4. The schema is distinct from qa-finding.schema.json (different title and
 *      $id).
 *   5. (Story #3738) The two-phase item lifecycle: a captured-but-untriaged
 *      item — Capture-phase fields present, `disposition` absent / null /
 *      `pending` / `untriaged` — validates, while a fully-triaged item
 *      (resolved `disposition`) validates exactly as before, and genuinely
 *      malformed items (out-of-enum `class`, missing Capture field, bad
 *      `disposition`) still fail. The Capture phase appends an item before
 *      Triage assigns a disposition (see `.agents/scripts/lib/qa/qa-session.js`,
 *      `readLedger` / `isUntriaged`), so the schema MUST accept that
 *      mid-flight shape or the resume path rejects exactly the records it is
 *      built to recover.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_DIR = path.resolve(__dirname, '..', '.agents', 'schemas');
const LEDGER_SCHEMA_PATH = path.join(SCHEMA_DIR, 'qa-ledger.schema.json');
const FINDING_SCHEMA_PATH = path.join(SCHEMA_DIR, 'qa-finding.schema.json');

const schema = JSON.parse(readFileSync(LEDGER_SCHEMA_PATH, 'utf8'));

function compile() {
  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  return ajv.compile(schema);
}

/** Canonical valid ledger item — every field present, including relates. */
function validLedgerItem(overrides = {}) {
  return {
    id: 'L1',
    class: 'product-bug',
    severity: 'high',
    evidence: 'Save button stays disabled after a valid form is completed',
    coverage: 'invoices/new',
    missingTest:
      'A contract test asserting the save handler enables on valid input',
    disposition: 'file',
    relates: ['L2'],
    ...overrides,
  };
}

describe('qa-ledger.schema.json — metadata', () => {
  it('exists and parses as JSON', () => {
    assert.ok(schema, 'schema loaded');
  });

  it('declares draft-07', () => {
    assert.equal(schema.$schema, 'http://json-schema.org/draft-07/schema#');
  });

  it('compiles cleanly under AJV', () => {
    assert.doesNotThrow(() => compile());
  });
});

describe('qa-ledger.schema.json — accepts a valid ledger item', () => {
  const validate = compile();

  it('accepts the canonical item (all fields incl. relates)', () => {
    const ok = validate(validLedgerItem());
    assert.equal(ok, true, JSON.stringify(validate.errors));
  });

  it('accepts an item without the optional relates field', () => {
    const item = validLedgerItem();
    delete item.relates;
    const ok = validate(item);
    assert.equal(ok, true, JSON.stringify(validate.errors));
  });

  it('accepts a null missingTest (no test gap applies)', () => {
    const ok = validate(
      validLedgerItem({ class: 'enhancement', missingTest: null }),
    );
    assert.equal(ok, true, JSON.stringify(validate.errors));
  });

  it('accepts every class in the enum', () => {
    for (const cls of [
      'product-bug',
      'environment-setup',
      'tooling-dx',
      'test-gap',
      'enhancement',
    ]) {
      const ok = validate(validLedgerItem({ class: cls }));
      assert.equal(ok, true, `expected ${cls} to validate`);
    }
  });
});

describe('qa-ledger.schema.json — rejects malformed ledger items', () => {
  const validate = compile();

  it('rejects a ledger item whose class is outside the enum', () => {
    const ok = validate(validLedgerItem({ class: 'mystery-class' }));
    assert.equal(ok, false, 'expected an out-of-enum class to be rejected');
    const enumError = (validate.errors ?? []).find(
      (e) => e.keyword === 'enum' && e.instancePath === '/class',
    );
    assert.ok(
      enumError,
      `expected an enum error on /class, got: ${JSON.stringify(validate.errors)}`,
    );
  });

  // Capture-phase fields are required at capture time, before Triage assigns
  // a disposition. `disposition` is deliberately NOT in this list (Story
  // #3738): it is only required once the item is triaged, so its absence is a
  // valid captured-but-untriaged shape — exercised in the lifecycle block
  // below — not a malformed item.
  for (const field of [
    'id',
    'class',
    'severity',
    'evidence',
    'coverage',
    'missingTest',
  ]) {
    it(`rejects an item missing required field: ${field}`, () => {
      const item = validLedgerItem();
      delete item[field];
      const ok = validate(item);
      assert.equal(ok, false, `expected failure for missing ${field}`);
    });
  }

  it('rejects an unknown top-level key (additionalProperties:false)', () => {
    const ok = validate(validLedgerItem({ mystery: true }));
    assert.equal(ok, false);
    const extra = (validate.errors ?? []).find(
      (e) => e.keyword === 'additionalProperties',
    );
    assert.ok(
      extra,
      `expected additionalProperties error, got: ${JSON.stringify(validate.errors)}`,
    );
  });

  it('rejects an id that does not match the L# pattern', () => {
    const ok = validate(validLedgerItem({ id: 'ledger-1' }));
    assert.equal(ok, false);
  });

  it('rejects a disposition outside the enum', () => {
    const ok = validate(validLedgerItem({ disposition: 'maybe' }));
    assert.equal(ok, false);
  });
});

describe('qa-ledger.schema.json — captured-but-untriaged lifecycle (Story #3738)', () => {
  const validate = compile();

  /**
   * A captured-but-untriaged item carries the Capture-phase fields but no
   * resolved disposition. This mirrors what `qa-session.js` appends during the
   * read-only Capture phase and reads back as the rolling backlog on resume.
   */
  function capturedItem(overrides = {}) {
    const item = validLedgerItem(overrides);
    delete item.disposition;
    delete item.relates;
    return { ...item, ...overrides };
  }

  it('accepts an untriaged item with disposition absent', () => {
    const ok = validate(capturedItem());
    assert.equal(ok, true, JSON.stringify(validate.errors));
  });

  it('accepts an untriaged item with disposition null', () => {
    const ok = validate(capturedItem({ disposition: null }));
    assert.equal(ok, true, JSON.stringify(validate.errors));
  });

  it('accepts an untriaged item with a pending/untriaged sentinel', () => {
    for (const sentinel of ['pending', 'untriaged']) {
      const ok = validate(capturedItem({ disposition: sentinel }));
      assert.equal(
        ok,
        true,
        `expected sentinel ${sentinel} to validate: ${JSON.stringify(validate.errors)}`,
      );
    }
  });

  it('accepts every Capture-phase class while untriaged', () => {
    for (const cls of [
      'product-bug',
      'environment-setup',
      'tooling-dx',
      'test-gap',
      'enhancement',
    ]) {
      const ok = validate(capturedItem({ class: cls }));
      assert.equal(
        ok,
        true,
        `expected untriaged ${cls} to validate: ${JSON.stringify(validate.errors)}`,
      );
    }
  });

  it('still rejects an untriaged item missing a Capture-phase field', () => {
    const item = capturedItem();
    delete item.evidence;
    const ok = validate(item);
    assert.equal(ok, false, 'expected a missing Capture field to be rejected');
  });

  it('still rejects an untriaged item whose class is outside the enum', () => {
    const ok = validate(capturedItem({ class: 'mystery-class' }));
    assert.equal(ok, false, 'expected an out-of-enum class to be rejected');
  });

  it('validates a fully-triaged item for each resolved disposition', () => {
    for (const disposition of ['file', 'defer', 'dismiss']) {
      const ok = validate(validLedgerItem({ disposition }));
      assert.equal(
        ok,
        true,
        `expected triaged disposition ${disposition} to validate: ${JSON.stringify(validate.errors)}`,
      );
    }
  });
});

describe('qa-ledger.schema.json — distinct from qa-finding.schema.json', () => {
  const findingSchema = JSON.parse(readFileSync(FINDING_SCHEMA_PATH, 'utf8'));

  it('has a different title from the finding schema', () => {
    assert.equal(schema.title, 'QaLedgerItem');
    assert.notEqual(schema.title, findingSchema.title);
  });

  it('has a distinct, non-empty $id', () => {
    assert.equal(typeof schema.$id, 'string');
    assert.ok(schema.$id.length > 0, 'ledger schema declares a non-empty $id');
    assert.notEqual(schema.$id, findingSchema.$id);
  });
});
