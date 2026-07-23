/**
 * close-validation-gates-enum.test.js — pin the gate-list ⊆ enum invariant.
 *
 * Story #4697. The close pipeline records per-gate validation evidence keyed
 * by `gateName`, validated against `.agents/schemas/validation-evidence.schema.json`.
 * That schema's `gateName` enum MUST be a superset of every gate name the
 * close-validation phase actually runs, or recording evidence for a gate
 * outside the enum fails schema validation — which is exactly how evidence for
 * `coverage-capture` (a full `npm run test:coverage`) and `check-baselines`
 * was silently dropped on every close, disabling the #4250 evidence-share
 * short-circuit for the two most expensive gates.
 *
 * These tests derive the gate names from the SAME source the close-validation
 * phase uses (`buildDefaultGates` in lib/close-validation/gates.js — imported
 * and invoked by single-story-close/phases/close-validation.js), never a
 * hardcoded copy, so a future gate addition or rename fails a test instead of
 * silently reopening the gap.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import Ajv from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

import { buildDefaultGates } from '../.agents/scripts/lib/close-validation/gates.js';

const SCHEMA_PATH = fileURLToPath(
  new URL(
    '../.agents/schemas/validation-evidence.schema.json',
    import.meta.url,
  ),
);

const PHASE_MODULE_PATH = fileURLToPath(
  new URL(
    '../.agents/scripts/lib/orchestration/single-story-close/phases/close-validation.js',
    import.meta.url,
  ),
);

const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));

/** The `gateName` enum from the evidence schema. */
function gateNameEnum() {
  return schema.properties.records.items.properties.gateName.enum;
}

/**
 * Derive the complete set of close-validation gate names from
 * `buildDefaultGates` — the gate SSOT the close-validation phase imports and
 * invokes. Some gates are emitted conditionally: `coverage-capture` replaces
 * the plain `test` gate only when the CRAP gate is enabled AND a
 * `test:coverage` script exists (Story #1798/#4473), while `check-baselines`
 * registers by default. Union the names across both coverage configurations so
 * every branch of the gate list is surfaced (injecting `packageScripts` keeps
 * the derivation independent of this checkout's own package.json).
 *
 * @returns {string[]}
 */
function deriveCloseValidationGateNames() {
  const names = new Set();
  for (const gate of buildDefaultGates({
    packageScripts: { 'test:coverage': 'c8 node --test' },
  })) {
    names.add(gate.name);
  }
  for (const gate of buildDefaultGates({ packageScripts: {} })) {
    names.add(gate.name);
  }
  return [...names];
}

/** A fresh AJV-2020 validator compiled against the evidence schema. */
function makeValidator() {
  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  return ajv.compile(schema);
}

/** A minimal well-formed evidence record for `gateName`. */
function evidenceRecord(gateName) {
  return {
    gateName,
    commitSha: '0123456789abcdef',
    commandConfigHash: `sha256:${'a'.repeat(64)}`,
    exitCode: 0,
    timestamp: '2026-07-23T00:00:00.000Z',
  };
}

/** Wrap records in a well-formed evidence document. */
function evidenceDoc(records) {
  return { storyId: 4697, schemaVersion: 1, records };
}

test('AC-1: evidence for coverage-capture and check-baselines validates against the schema', () => {
  const validate = makeValidator();
  const doc = evidenceDoc([
    evidenceRecord('coverage-capture'),
    evidenceRecord('check-baselines'),
  ]);
  const ok = validate(doc);
  assert.equal(
    ok,
    true,
    `expected coverage-capture + check-baselines evidence to validate; AJV errors: ${JSON.stringify(
      validate.errors,
    )}`,
  );
});

test('AC-2: every close-validation gate name is a member of the schema gateName enum', () => {
  const enumValues = new Set(gateNameEnum());
  const gateNames = deriveCloseValidationGateNames();

  // Guard against a refactor that silently empties the gate list and lets the
  // ⊆ check pass vacuously: the two gates this Story exists to cover MUST be
  // derivable from the live gate builder.
  assert.ok(
    gateNames.includes('coverage-capture'),
    'coverage-capture must be derivable from buildDefaultGates()',
  );
  assert.ok(
    gateNames.includes('check-baselines'),
    'check-baselines must be derivable from buildDefaultGates()',
  );

  for (const name of gateNames) {
    assert.ok(
      enumValues.has(name),
      `close-validation gate "${name}" is not in the validation-evidence gateName enum — ` +
        'evidence for it will fail schema validation. Add it to the enum in ' +
        '.agents/schemas/validation-evidence.schema.json (a schema bump per its own ' +
        '"additions require a schema bump" contract).',
    );
  }
});

test('AC-2 anchor: the close-validation phase sources its gates from buildDefaultGates', () => {
  // Ties the derivation above to the named phase module: if the phase stops
  // building gates via buildDefaultGates, deriveCloseValidationGateNames() must
  // be re-anchored on the new source rather than silently drifting.
  const phaseSrc = readFileSync(PHASE_MODULE_PATH, 'utf8');
  assert.match(
    phaseSrc,
    /buildDefaultGates/,
    'close-validation phase should build its gate list via buildDefaultGates; ' +
      're-anchor deriveCloseValidationGateNames() if this changes.',
  );
});
