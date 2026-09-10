import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { QA_SCHEMA } from '../.agents/scripts/lib/config-settings-schema.js';
import {
  QA_CONTRACT_DEFAULTS,
  QA_REQUIRED_FIELDS,
  resolveQaContract,
  resolveQaEnvironment,
} from '../.agents/scripts/lib/qa/resolve-qa-contract.js';
import { resolveSkillFile } from '../.agents/scripts/lib/skills/walk-skill-files.js';
import { makeTempDir } from '../.agents/scripts/lib/test-temp.js';

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

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
    // No `signInSeam`: an honestly seamless deployed target (Story #5135).
    // The field is optional, and a dangling skill id here would now throw.
    staging: {
      baseUrl: 'https://staging.example.test',
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
            signInSeam: { skill: 'stack/qa/acme-sso' },
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
            signInSeam: { skill: 'stack/qa/consumer-sign-in' },
          },
        },
      },
    });
    assert.deepEqual(out.environments.local.signInSeam, {
      skill: 'stack/qa/consumer-sign-in',
    });
  });

  it('rejects a malformed skill id at contract validation (Story #5285)', () => {
    // The id is joined onto a skills root to reach a SKILL.md, so the schema
    // carries `SKILL_ID_RE` as a `pattern` and a traversal never reaches the
    // path join. A single-segment id is rejected for the same reason: it
    // names no tier, so it can resolve under no root.
    for (const skill of ['../../secrets', 'Core/Foo', 'consumer-sign-in']) {
      assert.throws(
        () =>
          resolveQaContract({
            qa: {
              ...WELL_FORMED,
              environments: {
                local: {
                  baseUrl: 'http://localhost:3000',
                  signInSeam: { skill },
                },
              },
            },
          }),
        /must match pattern/,
        `signInSeam.skill \`${skill}\` must be rejected by the schema`,
      );
    }
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
          member: { signInSkill: 'stack/qa/acme-sso-member' },
        },
      },
    });
    assert.deepEqual(out.personas, {
      admin: { credentialRef: 'QA_ADMIN_CREDENTIAL' },
      member: { signInSkill: 'stack/qa/acme-sso-member' },
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
    assert.equal(env.signInSeam, null);
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

describe('resolveQaEnvironment — signInSeam resolution (Story #5135)', () => {
  /**
   * Stage a repo-shaped tree carrying one skill under the requested root, so
   * seam resolution is exercised against a real filesystem rather than a stub.
   *
   * @param {string[]} rootSegments e.g. ['.agents','local','skills']
   * @param {string} skillId e.g. 'stack/qa/acme-sso'
   * @returns {string} the staged repo root
   */
  function stageSkill(rootSegments, skillId) {
    const root = makeTempDir('qa-seam-');
    const dir = path.join(root, ...rootSegments, ...skillId.split('/'));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'SKILL.md'),
      `---\nname: ${path.basename(skillId)}\ndescription: staged\n---\n`,
    );
    return root;
  }

  /** A contract whose single `staging` environment carries `seam`. */
  function contractWithSeam(seam) {
    const environments = {
      staging: {
        baseUrl: 'https://staging.example.test',
        ...(seam === undefined ? {} : { signInSeam: seam }),
      },
    };
    return resolveQaContract({ qa: { ...WELL_FORMED, environments } });
  }

  it('accepts an environment that declares no seam, reporting it as null', () => {
    // The state the QA workflows already branch on (drive the unauthenticated
    // surface, record the gap) and that the schema used to forbid outright.
    const env = resolveQaEnvironment(contractWithSeam(undefined), 'staging');
    assert.equal(env.signInSeam, null);
    assert.equal(env.baseUrl, 'https://staging.example.test');
  });

  it('resolves a { skill } seam authored in the consumer-writable local zone', () => {
    const repoRoot = stageSkill(
      ['.agents', 'local', 'skills'],
      'stack/qa/acme-sso',
    );
    const env = resolveQaEnvironment(
      contractWithSeam({ skill: 'stack/qa/acme-sso' }),
      'staging',
      { repoRoot },
    );
    assert.equal(env.signInSeam.skill, 'stack/qa/acme-sso');
    assert.equal(
      env.signInSeam.skillPath,
      path.join(
        repoRoot,
        '.agents/local/skills/stack/qa/acme-sso/SKILL.md'
          .split('/')
          .join(path.sep),
      ),
    );
  });

  it('resolves a { skill } seam naming a payload skill', () => {
    const repoRoot = stageSkill(['.agents', 'skills'], 'stack/qa/shipped-seam');
    const env = resolveQaEnvironment(
      contractWithSeam({ skill: 'stack/qa/shipped-seam' }),
      'staging',
      { repoRoot },
    );
    assert.match(env.signInSeam.skillPath, /\.agents[/\\]skills[/\\]/);
  });

  it('throws at resolution time for an unresolvable { skill } seam, naming both roots', () => {
    // The #5134 defect: an unresolvable seam used to be returned unread and
    // only surfaced when a sweep reached its sign-in step.
    const repoRoot = makeTempDir('qa-seam-empty-');
    assert.throws(
      () =>
        resolveQaEnvironment(
          contractWithSeam({ skill: 'stack/qa/nope' }),
          'staging',
          { repoRoot },
        ),
      (err) => {
        assert.match(err.message, /stack\/qa\/nope/);
        assert.match(err.message, /\.agents\/skills/);
        assert.match(err.message, /\.agents\/local\/skills/);
        return true;
      },
    );
  });

  it('rejects a path-traversal skill id rather than resolving outside the roots', () => {
    // Since Story #5285 the schema's `pattern` catches this first, so a
    // traversal never reaches `resolveQaEnvironment` from a validated config
    // at all. Asserted at the door it is actually stopped at.
    assert.throws(
      () => contractWithSeam({ skill: '../../etc/passwd' }),
      /must match pattern/,
    );
  });

  it('names a malformed id as malformed, not as a skill to author (Story #5285)', () => {
    // Reached by a contract that skipped schema validation — a hand-assembled
    // one, or a config loaded past a degraded validator. The remedy differs
    // from the unresolvable case: "author the skill" is advice nobody can
    // follow for `../../etc/passwd`, so the two messages must differ.
    const repoRoot = makeTempDir('qa-seam-invalid-id-');
    const contract = {
      environments: {
        staging: {
          baseUrl: 'https://staging.example.test',
          signInSeam: { skill: '../../etc/passwd' },
        },
      },
      defaultEnvironment: 'staging',
    };
    assert.throws(
      () => resolveQaEnvironment(contract, 'staging', { repoRoot }),
      (err) => {
        assert.match(err.message, /not a well-formed skill id/);
        assert.doesNotMatch(err.message, /Author the skill/);
        return true;
      },
    );
  });

  it('reports a malformed id through resolveSkillFile itself', () => {
    // The distinguishable return is the seam the resolver branches on, so it
    // is asserted directly: `null` stays "resolved nowhere", and only a
    // malformed id carries the marker.
    const repoRoot = makeTempDir('qa-skill-id-');
    assert.deepEqual(resolveSkillFile(repoRoot, '../../secrets'), {
      reason: 'invalid-id',
    });
    assert.deepEqual(resolveSkillFile(repoRoot, 'Core/Foo'), {
      reason: 'invalid-id',
    });
    assert.equal(
      resolveSkillFile(repoRoot, 'stack/qa/well-formed-but-absent'),
      null,
      'a well-formed id that resolves nowhere stays null',
    );
  });

  it('leaves a { urlTemplate } seam untouched', () => {
    const env = resolveQaEnvironment(
      contractWithSeam({ urlTemplate: '/dev/sign-in-as/{persona}' }),
      'staging',
    );
    assert.deepEqual(env.signInSeam, {
      urlTemplate: '/dev/sign-in-as/{persona}',
    });
  });
});

describe('shipped schema defaults name no unresolvable skill (Story #5135)', () => {
  /** Every `skill` / `signInSkill` string reachable in a default value. */
  function skillIdsIn(value, out = []) {
    if (value === null || typeof value !== 'object') return out;
    for (const [key, v] of Object.entries(value)) {
      if ((key === 'skill' || key === 'signInSkill') && typeof v === 'string') {
        out.push(v);
      } else {
        skillIdsIn(v, out);
      }
    }
    return out;
  }

  it('bakes no skill id into any qa default', () => {
    // #5134: the shipped `environments` and `personas` defaults named
    // `stack/qa/sign-in` and `stack/qa/sign-in-member`, neither of which ships
    // in any release. A default is copied verbatim by consumers, so the only
    // safe number of unresolvable ids in one is zero — and since the framework
    // ships no sign-in skill, that means no skill id at all.
    const ids = skillIdsIn(QA_SCHEMA);
    assert.deepEqual(
      ids,
      [],
      `qa schema defaults name skill id(s) the package does not ship: ${ids.join(', ')}`,
    );
  });

  it('any skill id that ever appears in a default must resolve', () => {
    // Guards the invariant directly, so re-adding a resolvable illustrative
    // id stays legal while re-adding a dangling one does not.
    for (const id of skillIdsIn(QA_SCHEMA)) {
      assert.notEqual(
        resolveSkillFile(REPO_ROOT, id),
        null,
        `qa schema default names skill \`${id}\`, which resolves under no skills root`,
      );
    }
  });
});
