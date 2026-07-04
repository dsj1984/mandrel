import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  QA_CONTRACT_DEFAULTS,
  QA_REQUIRED_FIELDS,
  resolveQaContract,
  resolveQaEnvironment,
} from '../.agents/scripts/lib/qa/resolve-qa-contract.js';

/**
 * A minimal well-formed `qa` block carrying every harness-required field,
 * with a single `local` environment (Epic #4326 environment-keyed contract).
 */
const WELL_FORMED = Object.freeze({
  featureRoot: 'tests/features',
  fixturesManifest: 'tests/fixtures/personas.json',
  environments: {
    local: {
      baseUrl: 'http://localhost:3000',
      signInSeam: { urlTemplate: '/dev/sign-in-as/{persona}' },
    },
  },
  personas: { admin: { credentialRef: 'QA_ADMIN_CREDS' } },
});

/** A two-environment block: write-enabled local + read-only staging. */
const MULTI_ENV = Object.freeze({
  featureRoot: 'tests/features',
  fixturesManifest: 'tests/fixtures/personas.json',
  environments: {
    local: {
      baseUrl: 'http://localhost:3000',
      signInSeam: { urlTemplate: '/dev/sign-in-as/{persona}' },
    },
    staging: {
      baseUrl: 'https://staging.example.test',
      signInSeam: { skill: 'stack/qa/sign-in' },
    },
  },
  personas: ['admin'],
});

describe('resolveQaContract — present (well-formed, environment-keyed)', () => {
  it('returns the normalized contract with environments and defaultEnvironment', () => {
    const out = resolveQaContract({ qa: { ...WELL_FORMED } });
    assert.equal(out.featureRoot, 'tests/features');
    assert.equal(out.fixturesManifest, 'tests/fixtures/personas.json');
    assert.deepEqual(out.environments, {
      local: {
        baseUrl: 'http://localhost:3000',
        signInSeam: { urlTemplate: '/dev/sign-in-as/{persona}' },
      },
    });
    assert.equal(out.defaultEnvironment, 'local');
    assert.deepEqual(out.personas, {
      admin: { credentialRef: 'QA_ADMIN_CREDS' },
    });
    assert.deepEqual(out.personaNames, ['admin']);
  });

  it('no longer returns a top-level signInSeam field', () => {
    const out = resolveQaContract({ qa: { ...WELL_FORMED } });
    assert.ok(
      !Object.hasOwn(out, 'signInSeam'),
      'the resolved contract must not carry a top-level signInSeam',
    );
  });

  it('accepts a bare qa bag (not wrapped in config)', () => {
    const out = resolveQaContract({ ...WELL_FORMED });
    assert.equal(out.featureRoot, 'tests/features');
  });

  it('defaults defaultEnvironment to local when present among many', () => {
    const out = resolveQaContract({ qa: { ...MULTI_ENV } });
    assert.equal(out.defaultEnvironment, 'local');
  });

  it('defaults defaultEnvironment to the first environment when no local', () => {
    const out = resolveQaContract({
      qa: {
        ...MULTI_ENV,
        environments: {
          staging: MULTI_ENV.environments.staging,
          prod: {
            baseUrl: 'https://example.test',
            signInSeam: { skill: 'stack/qa/sign-in' },
          },
        },
      },
    });
    assert.equal(out.defaultEnvironment, 'staging');
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

  it('does not mutate the input environments block', () => {
    const input = { qa: { ...WELL_FORMED } };
    const out = resolveQaContract(input);
    out.environments.local.baseUrl = 'mutated';
    assert.equal(input.qa.environments.local.baseUrl, 'http://localhost:3000');
  });

  it('accepts the skill variant of a per-environment signInSeam', () => {
    const out = resolveQaContract({
      qa: {
        ...WELL_FORMED,
        environments: {
          local: {
            baseUrl: 'http://localhost:3000',
            signInSeam: { skill: 'consumer-sign-in' },
          },
        },
      },
    });
    assert.deepEqual(out.environments.local.signInSeam, {
      skill: 'consumer-sign-in',
    });
  });
});

describe('resolveQaContract — legacy top-level signInSeam is rejected', () => {
  it('rejects a block carrying the retired top-level qa.signInSeam', () => {
    const legacy = {
      featureRoot: 'tests/features',
      fixturesManifest: 'tests/fixtures/personas.json',
      signInSeam: { urlTemplate: '/dev/sign-in-as/{persona}' },
      personas: ['admin'],
    };
    // AJV rejects `signInSeam` as an unknown top-level field; the resolver
    // additionally reports `environments` missing. Either way it throws.
    assert.throws(
      () => resolveQaContract({ qa: legacy }),
      /signInSeam|environments/,
    );
  });

  it('rejects a block missing the environments field', () => {
    const partial = { ...WELL_FORMED };
    delete partial.environments;
    assert.throws(
      () => resolveQaContract({ qa: partial }),
      /missing required field `environments`|environments/,
    );
  });

  it('rejects an environment missing baseUrl', () => {
    assert.throws(
      () =>
        resolveQaContract({
          qa: {
            ...WELL_FORMED,
            environments: {
              local: { signInSeam: { skill: 'x' } },
            },
          },
        }),
      /qa\.environments/,
    );
  });

  it('rejects an empty environments map', () => {
    assert.throws(
      () => resolveQaContract({ qa: { ...WELL_FORMED, environments: {} } }),
      /qa\.environments/,
    );
  });
});

describe('resolveQaContract — personas normalization (Story #3306)', () => {
  /** Base block carrying a single url-template dev-impersonation environment. */
  const URL_SEAM_BASE = Object.freeze({
    featureRoot: 'tests/features',
    fixturesManifest: 'tests/fixtures/personas.json',
    environments: {
      local: {
        baseUrl: 'http://localhost:3000',
        signInSeam: { urlTemplate: '/dev/sign-in-as/{persona}' },
      },
    },
  });

  it('accepts a name-only string[] under a urlTemplate seam', () => {
    const out = resolveQaContract({
      qa: { ...URL_SEAM_BASE, personas: ['athlete', 'coach', 'org-admin'] },
    });
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

  it('exposes the canonical required-field list', () => {
    assert.deepEqual(
      [...QA_REQUIRED_FIELDS],
      ['featureRoot', 'fixturesManifest', 'environments', 'personas'],
    );
  });
});

describe('resolveQaEnvironment — selection by name / URL / default', () => {
  const contract = resolveQaContract({ qa: { ...MULTI_ENV } });

  it('resolves an environment by exact name', () => {
    const env = resolveQaEnvironment(contract, 'staging');
    assert.equal(env.name, 'staging');
    assert.equal(env.baseUrl, 'https://staging.example.test');
    assert.deepEqual(env.signInSeam, { skill: 'stack/qa/sign-in' });
  });

  it('resolves an environment by raw-URL origin match against baseUrl', () => {
    const env = resolveQaEnvironment(
      contract,
      'https://staging.example.test/some/path?query=1',
    );
    assert.equal(env.name, 'staging');
  });

  it('resolves the default environment when no target is passed', () => {
    const env = resolveQaEnvironment(contract);
    assert.equal(env.name, 'local');
  });

  it('resolves the default environment for an empty-string target', () => {
    const env = resolveQaEnvironment(contract, '');
    assert.equal(env.name, 'local');
  });

  it('matches on origin even when baseUrl has no path but target does', () => {
    const localContract = resolveQaContract({ qa: { ...WELL_FORMED } });
    const env = resolveQaEnvironment(
      localContract,
      'http://localhost:3000/anything',
    );
    assert.equal(env.name, 'local');
  });
});

describe('resolveQaEnvironment — allowWrites defaulting', () => {
  it('defaults allowWrites to true only for the local environment', () => {
    const contract = resolveQaContract({ qa: { ...MULTI_ENV } });
    assert.equal(resolveQaEnvironment(contract, 'local').allowWrites, true);
    assert.equal(resolveQaEnvironment(contract, 'staging').allowWrites, false);
  });

  it('honors an explicit allowWrites: true on a non-local environment', () => {
    const contract = resolveQaContract({
      qa: {
        ...MULTI_ENV,
        environments: {
          ...MULTI_ENV.environments,
          staging: {
            ...MULTI_ENV.environments.staging,
            allowWrites: true,
          },
        },
      },
    });
    assert.equal(resolveQaEnvironment(contract, 'staging').allowWrites, true);
  });

  it('honors an explicit allowWrites: false on the local environment', () => {
    const contract = resolveQaContract({
      qa: {
        ...WELL_FORMED,
        environments: {
          local: {
            ...WELL_FORMED.environments.local,
            allowWrites: false,
          },
        },
      },
    });
    assert.equal(resolveQaEnvironment(contract, 'local').allowWrites, false);
  });
});

describe('resolveQaEnvironment — loud failure', () => {
  const contract = resolveQaContract({ qa: { ...MULTI_ENV } });

  it('throws naming the known environments for an unknown name', () => {
    assert.throws(
      () => resolveQaEnvironment(contract, 'production'),
      /unknown environment `production`.*`local`.*`staging`/s,
    );
  });

  it('throws naming the known environments for an unmatched URL', () => {
    assert.throws(
      () => resolveQaEnvironment(contract, 'https://nope.example.test'),
      /unknown environment.*`local`.*`staging`/s,
    );
  });

  it('prefers an exact name match over URL parsing', () => {
    // `local` is a valid name and does not parse as an absolute URL; the
    // name path resolves it without attempting origin matching.
    const env = resolveQaEnvironment(contract, 'local');
    assert.equal(env.name, 'local');
  });
});
