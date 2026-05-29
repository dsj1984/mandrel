import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  QA_CONTRACT_DEFAULTS,
  QA_REQUIRED_FIELDS,
  resolveQaContract,
} from '../.agents/scripts/lib/qa/resolve-qa-contract.js';

/** A minimal well-formed `qa` block carrying every harness-required field. */
const WELL_FORMED = Object.freeze({
  featureRoot: 'tests/features',
  fixturesManifest: 'tests/fixtures/personas.json',
  signInSeam: { urlTemplate: '/dev/sign-in-as/{persona}' },
  personas: { admin: { credentialRef: 'QA_ADMIN_CREDS' } },
});

describe('resolveQaContract — present (well-formed)', () => {
  it('returns the normalized contract object for a full block', () => {
    const out = resolveQaContract({ qa: { ...WELL_FORMED } });
    assert.equal(out.featureRoot, 'tests/features');
    assert.equal(out.fixturesManifest, 'tests/fixtures/personas.json');
    assert.deepEqual(out.signInSeam, {
      urlTemplate: '/dev/sign-in-as/{persona}',
    });
    assert.deepEqual(out.personas, {
      admin: { credentialRef: 'QA_ADMIN_CREDS' },
    });
    assert.deepEqual(out.personaNames, ['admin']);
  });

  it('accepts a bare qa bag (not wrapped in config)', () => {
    const out = resolveQaContract({ ...WELL_FORMED });
    assert.equal(out.featureRoot, 'tests/features');
  });

  it('defaults the optional fields when omitted', () => {
    const out = resolveQaContract({ qa: { ...WELL_FORMED } });
    assert.deepEqual(
      out.consoleAllowlist,
      QA_CONTRACT_DEFAULTS.consoleAllowlist,
    );
    assert.equal(out.designTokens, QA_CONTRACT_DEFAULTS.designTokens);
  });

  it('passes optional fields through when present', () => {
    const out = resolveQaContract({
      qa: {
        ...WELL_FORMED,
        consoleAllowlist: ['Download the React DevTools'],
        designTokens: 'tokens/design.json',
      },
    });
    assert.deepEqual(out.consoleAllowlist, ['Download the React DevTools']);
    assert.equal(out.designTokens, 'tokens/design.json');
  });

  it('does not mutate the input block', () => {
    const input = { qa: { ...WELL_FORMED } };
    const out = resolveQaContract(input);
    out.consoleAllowlist.push('mutated');
    assert.deepEqual(input.qa.consoleAllowlist, undefined);
  });

  it('accepts the skill variant of signInSeam', () => {
    const out = resolveQaContract({
      qa: { ...WELL_FORMED, signInSeam: { skill: 'consumer-sign-in' } },
    });
    assert.deepEqual(out.signInSeam, { skill: 'consumer-sign-in' });
  });
});

describe('resolveQaContract — personas normalization (Story #3306)', () => {
  /** Base block carrying a url-template dev-impersonation seam. */
  const URL_SEAM_BASE = Object.freeze({
    featureRoot: 'tests/features',
    fixturesManifest: 'tests/fixtures/personas.json',
    signInSeam: { urlTemplate: '/dev/sign-in-as/{persona}' },
  });

  it('accepts a name-only string[] under a urlTemplate seam', () => {
    const out = resolveQaContract({
      qa: { ...URL_SEAM_BASE, personas: ['athlete', 'coach', 'org-admin'] },
    });
    // Acceptance: resolves cleanly with no fabricated credentialRef/signInSkill.
    assert.deepEqual(out.personas, {
      athlete: {},
      coach: {},
      'org-admin': {},
    });
    assert.deepEqual(out.personaNames, ['athlete', 'coach', 'org-admin']);
  });

  it('normalizes the name-only array to an empty-record canonical map', () => {
    const out = resolveQaContract({
      qa: { ...URL_SEAM_BASE, personas: ['athlete'] },
    });
    assert.deepEqual(out.personas.athlete, {});
  });

  it('keeps the object-map form for credential/skill seams', () => {
    const out = resolveQaContract({
      qa: {
        ...URL_SEAM_BASE,
        signInSeam: { skill: 'stack/qa/sign-in' },
        personas: {
          admin: { credentialRef: 'QA_ADMIN_CREDENTIAL' },
          member: { signInSkill: 'stack/qa/sign-in-member' },
        },
      },
    });
    assert.deepEqual(out.personas, {
      admin: { credentialRef: 'QA_ADMIN_CREDENTIAL' },
      member: { signInSkill: 'stack/qa/sign-in-member' },
    });
    assert.deepEqual(out.personaNames, ['admin', 'member']);
  });

  it('does not mutate an object-map personas input', () => {
    const input = {
      qa: {
        ...URL_SEAM_BASE,
        personas: { admin: { credentialRef: 'QA_ADMIN_CREDENTIAL' } },
      },
    };
    const out = resolveQaContract(input);
    out.personas.admin.credentialRef = 'mutated';
    assert.equal(input.qa.personas.admin.credentialRef, 'QA_ADMIN_CREDENTIAL');
  });

  it('does not mutate a name-only personas input', () => {
    const personas = ['athlete', 'coach'];
    const input = { qa: { ...URL_SEAM_BASE, personas } };
    resolveQaContract(input);
    assert.deepEqual(personas, ['athlete', 'coach']);
  });

  it('rejects an empty name-only array (personas is required)', () => {
    assert.throws(
      () => resolveQaContract({ qa: { ...URL_SEAM_BASE, personas: [] } }),
      /qa\.personas/,
    );
  });

  it('rejects an empty object-map (personas is required)', () => {
    assert.throws(
      () => resolveQaContract({ qa: { ...URL_SEAM_BASE, personas: {} } }),
      /qa\.personas/,
    );
  });

  it('rejects a name-only array with a blank persona name', () => {
    assert.throws(
      () => resolveQaContract({ qa: { ...URL_SEAM_BASE, personas: [''] } }),
      /qa\.personas/,
    );
  });
});

describe('resolveQaContract — absent (loud, no fallback)', () => {
  const PHRASE = /this project has not bound the QA harness/;

  it('throws the loud phrase when config has no qa block', () => {
    assert.throws(() => resolveQaContract({ project: {} }), PHRASE);
  });

  it('throws the loud phrase when passed null/undefined', () => {
    assert.throws(() => resolveQaContract(null), PHRASE);
    assert.throws(() => resolveQaContract(undefined), PHRASE);
  });

  it('throws the loud phrase for an empty qa block', () => {
    assert.throws(() => resolveQaContract({ qa: {} }), PHRASE);
  });

  it('throws the loud phrase when qa is not an object', () => {
    assert.throws(() => resolveQaContract({ qa: 'tests/features' }), PHRASE);
    assert.throws(() => resolveQaContract({ qa: [] }), PHRASE);
  });
});

describe('resolveQaContract — malformed (actionable, names field)', () => {
  it('names a wrong-typed field', () => {
    assert.throws(
      () => resolveQaContract({ qa: { ...WELL_FORMED, featureRoot: 42 } }),
      /qa\.featureRoot/,
    );
  });

  it('names an unknown field', () => {
    assert.throws(
      () => resolveQaContract({ qa: { ...WELL_FORMED, bogus: true } }),
      /qa has an unknown field `bogus`/,
    );
  });

  it('names a missing required field (when others are present)', () => {
    const partial = { ...WELL_FORMED };
    delete partial.fixturesManifest;
    assert.throws(
      () => resolveQaContract({ qa: partial }),
      /missing required field `fixturesManifest`/,
    );
  });

  it('rejects an invalid signInSeam shape by name', () => {
    assert.throws(
      () =>
        resolveQaContract({
          qa: { ...WELL_FORMED, signInSeam: { wrong: 'x' } },
        }),
      /qa\.signInSeam/,
    );
  });

  it('exposes the canonical required-field list', () => {
    assert.deepEqual(
      [...QA_REQUIRED_FIELDS],
      ['featureRoot', 'fixturesManifest', 'signInSeam', 'personas'],
    );
  });
});
