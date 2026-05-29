/**
 * Contract tests for `.agents/schemas/qa-finding.schema.json`.
 *
 * Story #3300 (Feature #3289 "Instrumentation, inspection & findings",
 * Epic #3214). The agent-driven QA harness turns genuine problems surfaced
 * during a browser sweep into structured `F#` findings; this schema is the
 * contract those findings are validated against before they are bundled into
 * operator-approved follow-up ticket drafts.
 *
 * Verifies:
 *   1. The schema exists, parses, declares draft-07, and compiles under AJV.
 *   2. A valid finding carrying classification, surface, symptom, likely root
 *      cause, disposition, acceptance, optional folds-into, and
 *      console/network evidence round-trips cleanly.
 *   3. A finding missing any required field is rejected.
 *   4. The console-derived subset produced by `filterConsoleMessages` (the
 *      sibling instrumentation module) validates against the schema, proving
 *      producer/consumer alignment.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { filterConsoleMessages } from '../.agents/scripts/lib/qa/console-allowlist.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.resolve(
  __dirname,
  '..',
  '.agents',
  'schemas',
  'qa-finding.schema.json',
);

const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));

function compile() {
  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  return ajv.compile(schema);
}

/** Canonical valid finding — every required field present, plus foldsInto. */
function validFinding(overrides = {}) {
  return {
    id: 'F1',
    classification: 'console-error',
    surface: 'invoices/new',
    symptom: 'Uncaught TypeError: cannot read properties of undefined',
    likelyRootCause: 'Invoice form renders before the customer list resolves',
    disposition: 'follow-up',
    acceptance: 'The new-invoice form loads without a console error',
    foldsInto: 'F2',
    evidence: {
      console: [
        {
          level: 'error',
          text: 'Uncaught TypeError: cannot read properties of undefined',
        },
      ],
      network: [
        {
          url: '/api/customers',
          status: 500,
          method: 'GET',
        },
      ],
    },
    ...overrides,
  };
}

describe('qa-finding.schema.json — metadata', () => {
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

describe('qa-finding.schema.json — accepts a valid finding', () => {
  const validate = compile();

  it('accepts the canonical finding (all fields incl. foldsInto)', () => {
    const ok = validate(validFinding());
    assert.equal(ok, true, JSON.stringify(validate.errors));
  });

  it('accepts a finding without the optional foldsInto field', () => {
    const finding = validFinding();
    delete finding.foldsInto;
    const ok = validate(finding);
    assert.equal(ok, true, JSON.stringify(validate.errors));
  });

  it('accepts null likelyRootCause and null acceptance (not yet inferred)', () => {
    const ok = validate(
      validFinding({ likelyRootCause: null, acceptance: null }),
    );
    assert.equal(ok, true, JSON.stringify(validate.errors));
  });

  it('accepts empty console and network evidence arrays', () => {
    const ok = validate(
      validFinding({ evidence: { console: [], network: [] } }),
    );
    assert.equal(ok, true, JSON.stringify(validate.errors));
  });

  it('accepts the blocker disposition and a behavior classification', () => {
    const ok = validate(
      validFinding({ disposition: 'blocker', classification: 'behavior' }),
    );
    assert.equal(ok, true, JSON.stringify(validate.errors));
  });
});

describe('qa-finding.schema.json — rejects malformed findings', () => {
  const validate = compile();

  for (const field of [
    'id',
    'classification',
    'surface',
    'symptom',
    'likelyRootCause',
    'disposition',
    'acceptance',
    'evidence',
  ]) {
    it(`rejects a finding missing required field: ${field}`, () => {
      const finding = validFinding();
      delete finding[field];
      const ok = validate(finding);
      assert.equal(
        ok,
        false,
        `expected validation failure for missing ${field}`,
      );
    });
  }

  it('rejects an unknown top-level key (additionalProperties:false)', () => {
    const ok = validate(validFinding({ mystery: true }));
    assert.equal(ok, false);
    const extra = (validate.errors ?? []).find(
      (e) => e.keyword === 'additionalProperties',
    );
    assert.ok(
      extra,
      `expected additionalProperties error, got: ${JSON.stringify(validate.errors)}`,
    );
  });

  it('rejects an id that does not match the F# pattern', () => {
    const ok = validate(validFinding({ id: 'finding-1' }));
    assert.equal(ok, false);
  });

  it('rejects a classification outside the enum', () => {
    const ok = validate(validFinding({ classification: 'mystery-error' }));
    assert.equal(ok, false);
  });

  it('rejects a disposition outside the enum', () => {
    const ok = validate(validFinding({ disposition: 'maybe' }));
    assert.equal(ok, false);
  });

  it('rejects evidence missing the network array', () => {
    const ok = validate(validFinding({ evidence: { console: [] } }));
    assert.equal(ok, false);
  });

  it('rejects a console evidence entry missing text', () => {
    const ok = validate(
      validFinding({
        evidence: { console: [{ level: 'error' }], network: [] },
      }),
    );
    assert.equal(ok, false);
  });

  it('rejects a network evidence entry with a non-integer status', () => {
    const ok = validate(
      validFinding({
        evidence: {
          console: [],
          network: [{ url: '/api/x', status: '500' }],
        },
      }),
    );
    assert.equal(ok, false);
  });
});

describe('qa-finding.schema.json — producer/consumer alignment', () => {
  const validate = compile();

  it('validates the console-derived subset from filterConsoleMessages', () => {
    const findings = filterConsoleMessages(
      [
        { level: 'error', text: 'Boom: render failed' },
        { level: 'log', text: 'noise' },
      ],
      [],
      { surface: 'dashboard' },
    );
    assert.equal(findings.length, 1, 'one finding from one console error');
    for (const finding of findings) {
      const ok = validate(finding);
      assert.equal(ok, true, JSON.stringify(validate.errors));
    }
  });
});
