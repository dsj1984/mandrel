/**
 * tests/audit-suite/resolve-lens-tier.test.js — Story #4407 (Epic #4405).
 *
 * Pins the concern-ownership data model that replaced the `alwaysRun` special
 * case with a per-lens `scope` field:
 *   - `resolveLensTier` (imported from the audit-suite SDK barrel) returns one
 *     of `local | cumulative | global` for every lens registered in
 *     `audit-rules.json`, and throws on an unknown lens.
 *   - `audit-rules.json` declares a scope on all 14 lenses (including
 *     `audit-sre`, re-homed from the dead gate4-only state to gate3 with ops
 *     filePatterns by Story #4629) and no longer carries `alwaysRun`.
 *   - `audit-rules.schema.json` requires the `scope` enum and no longer
 *     permits `alwaysRun` (a fixture rule carrying it fails validation).
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import Ajv from 'ajv';

// Import through the SDK barrel — the acceptance contract is that consumers
// reach the resolver via `lib/audit-suite/index.js`, not the selector module.
import {
  LENS_TIERS,
  resolveLensTier,
} from '../../.agents/scripts/lib/audit-suite/index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCHEMAS_ROOT = path.join(HERE, '..', '..', '.agents', 'schemas');
const RULES_PATH = path.join(SCHEMAS_ROOT, 'audit-rules.json');
const SCHEMA_PATH = path.join(SCHEMAS_ROOT, 'audit-rules.schema.json');

const rules = JSON.parse(readFileSync(RULES_PATH, 'utf8'));
const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));

const LENS_KEYS = Object.keys(rules.audits);

/**
 * Canonical tier assignment from Epic #4405's data model. Pinned here as a
 * regression guard so a silent re-tier of any lens is a test failure, not a
 * quiet routing change.
 */
const EXPECTED_TIERS = {
  'audit-clean-code': 'local',
  'audit-security': 'local',
  'audit-privacy': 'local',
  'audit-performance': 'local',
  'audit-quality': 'local',
  'audit-lighthouse': 'local',
  'audit-ux-ui': 'local',
  'audit-seo': 'local',
  'audit-architecture': 'cumulative',
  'audit-dependencies': 'cumulative',
  'audit-devops': 'cumulative',
  'audit-documentation': 'cumulative',
  'audit-sre': 'cumulative',
  'audit-navigability': 'global',
};

test('LENS_TIERS is the frozen local|cumulative|global tuple', () => {
  assert.deepEqual([...LENS_TIERS], ['local', 'cumulative', 'global']);
  assert.ok(Object.isFrozen(LENS_TIERS), 'LENS_TIERS must be frozen');
});

test('audit-rules.json registers all 14 lenses, each with a scope in the enum', () => {
  assert.equal(
    LENS_KEYS.length,
    14,
    `expected 14 registered lenses, got ${LENS_KEYS.length}: ${LENS_KEYS.join(', ')}`,
  );
  for (const lens of LENS_KEYS) {
    const { scope } = rules.audits[lens];
    assert.ok(
      LENS_TIERS.includes(scope),
      `lens '${lens}' declares scope '${scope}', not one of ${LENS_TIERS.join(', ')}`,
    );
  }
});

test('audit-sre is re-homed from the dead gate4 state to gate3 with ops filePatterns (Story #4629)', () => {
  const sre = rules.audits['audit-sre'];
  assert.ok(LENS_TIERS.includes(sre?.scope), 'audit-sre must declare a scope');
  const gates = sre?.triggers?.gates ?? [];
  assert.ok(
    gates.includes('gate3'),
    `audit-sre must route at gate3 so a production caller reaches it; got ${JSON.stringify(gates)}`,
  );
  assert.ok(
    !gates.includes('gate4'),
    'audit-sre must no longer be pinned to the dead gate4-only state',
  );
  const patterns = sre?.triggers?.filePatterns ?? [];
  assert.ok(
    patterns.includes('.github/workflows/**') &&
      patterns.some((p) => p.includes('Dockerfile')) &&
      patterns.includes('**/migrations/**'),
    `audit-sre must carry ops filePatterns (workflows, Dockerfile, migrations); got ${JSON.stringify(patterns)}`,
  );
});

test('alwaysRun is gone from every entry in audit-rules.json', () => {
  const raw = readFileSync(RULES_PATH, 'utf8');
  assert.ok(
    !raw.includes('alwaysRun'),
    'the alwaysRun key must be removed from audit-rules.json',
  );
  for (const lens of LENS_KEYS) {
    assert.equal(
      rules.audits[lens].triggers?.alwaysRun,
      undefined,
      `lens '${lens}' still carries a triggers.alwaysRun field`,
    );
  }
});

test('resolveLensTier returns a valid tier for every registered lens', () => {
  for (const lens of LENS_KEYS) {
    const tier = resolveLensTier(lens);
    assert.ok(
      LENS_TIERS.includes(tier),
      `resolveLensTier('${lens}') returned '${tier}', not one of ${LENS_TIERS.join(', ')}`,
    );
  }
});

test('resolveLensTier matches the pinned Epic #4405 tier assignment', () => {
  assert.deepEqual(
    Object.fromEntries(LENS_KEYS.map((lens) => [lens, resolveLensTier(lens)])),
    EXPECTED_TIERS,
  );
});

test('resolveLensTier throws on an unknown lens', () => {
  assert.throws(
    () => resolveLensTier('audit-does-not-exist'),
    /unknown lens 'audit-does-not-exist'/,
  );
});

// ---------------------------------------------------------------------------
// Schema contract: scope required, alwaysRun rejected.
// ---------------------------------------------------------------------------

function makeValidator() {
  const ajv = new Ajv({ allErrors: true, strict: false });
  return ajv.compile(schema);
}

/** Minimal one-lens manifest used to probe the schema in isolation. */
function manifest(entry) {
  return { version: 1, audits: { 'audit-fixture': entry } };
}

test('the real audit-rules.json validates against its schema', () => {
  const validate = makeValidator();
  assert.ok(
    validate(rules),
    `audit-rules.json failed schema validation: ${JSON.stringify(validate.errors)}`,
  );
});

test('schema requires the scope enum on every audit entry', () => {
  const validate = makeValidator();
  const missingScope = manifest({
    triggers: { gates: ['gate1'] },
    substitutionKeys: [],
  });
  assert.equal(
    validate(missingScope),
    false,
    'an audit entry without a scope must fail validation',
  );

  const badScope = manifest({
    triggers: { gates: ['gate1'] },
    scope: 'epic',
    substitutionKeys: [],
  });
  assert.equal(
    makeValidator()(badScope),
    false,
    "a scope outside local|cumulative|global (e.g. 'epic') must fail validation",
  );
});

test('schema no longer permits alwaysRun (a fixture rule carrying it fails validation)', () => {
  const validate = makeValidator();
  const withAlwaysRun = manifest({
    triggers: { gates: ['gate1'], alwaysRun: true },
    scope: 'local',
    substitutionKeys: [],
  });
  assert.equal(
    validate(withAlwaysRun),
    false,
    'a triggers.alwaysRun field must be rejected by the schema',
  );
});

test('a well-formed scope-carrying entry validates', () => {
  const validate = makeValidator();
  const ok = manifest({
    triggers: { gates: ['gate1', 'gate3'] },
    scope: 'cumulative',
    substitutionKeys: [],
  });
  assert.ok(
    validate(ok),
    `a well-formed entry should validate: ${JSON.stringify(validate.errors)}`,
  );
});
