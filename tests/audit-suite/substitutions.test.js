import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyImplicitSubstitutions,
  applySubstitutions,
  BUILT_IN_SUBSTITUTION_KEYS,
  computeAllowedKeys,
  parseSubstitutionPairs,
} from '../../.agents/scripts/lib/audit-suite/substitutions.js';
import { ValidationError } from '../../.agents/scripts/lib/errors/index.js';

test('BUILT_IN_SUBSTITUTION_KEYS: stable, frozen, includes the canonical trio', () => {
  assert.deepEqual(
    [...BUILT_IN_SUBSTITUTION_KEYS],
    ['auditOutputDir', 'ticketId', 'baseBranch'],
  );
  assert.throws(() => {
    BUILT_IN_SUBSTITUTION_KEYS.push('nope');
  });
});

test('applySubstitutions: replaces every {{key}} occurrence', () => {
  const out = applySubstitutions('a={{x}} b={{x}} c={{y}} unknown={{z}}', {
    x: '1',
    y: '2',
  });
  assert.equal(out, 'a=1 b=1 c=2 unknown={{z}}');
});

test('applySubstitutions: regex-special characters in keys are escaped', () => {
  const out = applySubstitutions('foo {{a.b}} bar', { 'a.b': 'OK' });
  assert.equal(out, 'foo OK bar');
});

test('parseSubstitutionPairs: turns key=value pairs into an object', () => {
  const out = parseSubstitutionPairs(['ticketId=42', 'baseBranch=main']);
  assert.deepEqual(out, { ticketId: '42', baseBranch: 'main' });
});

test('parseSubstitutionPairs: defaults to {} when input omitted', () => {
  assert.deepEqual(parseSubstitutionPairs(), {});
});

test('parseSubstitutionPairs: preserves "=" inside the value side', () => {
  assert.deepEqual(parseSubstitutionPairs(['raw=key=value=more']), {
    raw: 'key=value=more',
  });
});

test('parseSubstitutionPairs: rejects entries with no =', () => {
  assert.throws(
    () => parseSubstitutionPairs(['nope']),
    (err) => err instanceof ValidationError && /key=value/.test(err.message),
  );
});

test('parseSubstitutionPairs: rejects entries that start with =', () => {
  assert.throws(
    () => parseSubstitutionPairs(['=missing-key']),
    (err) => err instanceof ValidationError,
  );
});

test('applyImplicitSubstitutions: copies --ticket into ticketId when absent', () => {
  const subs = {};
  applyImplicitSubstitutions({ ticket: '525' }, subs);
  assert.equal(subs.ticketId, '525');
});

test('applyImplicitSubstitutions: does not override caller-supplied ticketId', () => {
  const subs = { ticketId: 'explicit' };
  applyImplicitSubstitutions({ ticket: '999' }, subs);
  assert.equal(subs.ticketId, 'explicit');
});

test('applyImplicitSubstitutions: copies --base-branch into baseBranch when absent', () => {
  const subs = {};
  applyImplicitSubstitutions({ 'base-branch': 'develop' }, subs);
  assert.equal(subs.baseBranch, 'develop');
});

test('applyImplicitSubstitutions: leaves caller-supplied baseBranch alone', () => {
  const subs = { baseBranch: 'main' };
  applyImplicitSubstitutions({ 'base-branch': 'develop' }, subs);
  assert.equal(subs.baseBranch, 'main');
});

test('computeAllowedKeys: returns built-ins when no audits supplied', () => {
  const allowed = computeAllowedKeys({}, []);
  assert.deepEqual([...allowed].sort(), [
    'auditOutputDir',
    'baseBranch',
    'ticketId',
  ]);
});

test('computeAllowedKeys: unions built-ins with audit-declared keys', () => {
  const rules = {
    audits: {
      'audit-alpha': { substitutionKeys: ['alphaKey', 'sharedKey'] },
      'audit-beta': { substitutionKeys: ['sharedKey', 'betaKey'] },
    },
  };
  const allowed = computeAllowedKeys(rules, ['audit-alpha', 'audit-beta']);
  assert.ok(allowed.has('alphaKey'));
  assert.ok(allowed.has('betaKey'));
  assert.ok(allowed.has('sharedKey'));
  for (const k of BUILT_IN_SUBSTITUTION_KEYS) {
    assert.ok(allowed.has(k), `built-in ${k} missing`);
  }
});

test('computeAllowedKeys: silently ignores audits not in rules', () => {
  const allowed = computeAllowedKeys({ audits: {} }, ['ghost']);
  assert.equal(allowed.size, BUILT_IN_SUBSTITUTION_KEYS.length);
});
