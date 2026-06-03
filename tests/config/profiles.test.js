import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  listProfiles,
  PROFILE_NAMES,
  PROFILES_DIR,
  profilePath,
  resolveProfile,
} from '../../.agents/scripts/lib/config/profiles.js';
import { getAgentrcValidator } from '../../.agents/scripts/lib/config-settings-schema.js';

const EXPECTED_PROFILES = [
  'solo-local',
  'team-github',
  'qa-only',
  'audit-only',
];

describe('listProfiles', () => {
  it('returns the four canonical profile names', () => {
    const names = listProfiles();
    assert.deepEqual([...names].sort(), [...EXPECTED_PROFILES].sort());
    assert.equal(names.length, 4);
  });

  it('returns names in the pinned display order', () => {
    assert.deepEqual(listProfiles(), EXPECTED_PROFILES);
  });

  it('returns a fresh array the caller may mutate without side effects', () => {
    const first = listProfiles();
    first.push('mutated');
    assert.deepEqual(listProfiles(), EXPECTED_PROFILES);
  });

  it('exports PROFILE_NAMES as a frozen tuple matching the listing', () => {
    assert.ok(Object.isFrozen(PROFILE_NAMES));
    assert.deepEqual([...PROFILE_NAMES], EXPECTED_PROFILES);
  });
});

describe('profilePath', () => {
  it('resolves a name to a <name>.json file under PROFILES_DIR', () => {
    const p = profilePath('solo-local');
    assert.ok(p.startsWith(PROFILES_DIR));
    assert.ok(p.endsWith('solo-local.json'));
  });
});

describe('resolveProfile — schema validity', () => {
  for (const name of EXPECTED_PROFILES) {
    it(`returns a delta seed for "${name}" that validates against the agentrc schema`, () => {
      const seed = resolveProfile(name);
      const validate = getAgentrcValidator();
      const ok = validate(seed);
      assert.equal(
        ok,
        true,
        `seed for "${name}" failed validation: ${JSON.stringify(validate.errors)}`,
      );
    });

    it(`strips the editor $schema pointer from the "${name}" seed`, () => {
      const seed = resolveProfile(name);
      assert.equal(
        Object.hasOwn(seed, '$schema'),
        false,
        `"${name}" seed should not carry a $schema key`,
      );
    });

    it(`returns a seed for "${name}" carrying the required project block`, () => {
      const seed = resolveProfile(name);
      assert.ok(seed.project, `"${name}" seed must carry project`);
      assert.ok(seed.project.paths, `"${name}" seed must carry project.paths`);
    });
  }
});

describe('resolveProfile — solo-local is minimal', () => {
  it('omits the github block and team/GitHub-only keys', () => {
    const seed = resolveProfile('solo-local');
    assert.equal(
      Object.hasOwn(seed, 'github'),
      false,
      'solo-local must omit the github block',
    );
    assert.equal(
      Object.hasOwn(seed, 'qa'),
      false,
      'solo-local must omit the qa block',
    );
    assert.equal(
      Object.hasOwn(seed, 'delivery'),
      false,
      'solo-local must omit the delivery block',
    );
  });

  it('carries only project so its resolved config stays minimal', () => {
    const seed = resolveProfile('solo-local');
    assert.deepEqual(Object.keys(seed), ['project']);
  });

  it('is the smallest seed by top-level key count', () => {
    const soloKeys = Object.keys(resolveProfile('solo-local')).length;
    for (const name of EXPECTED_PROFILES) {
      if (name === 'solo-local') continue;
      const otherKeys = Object.keys(resolveProfile(name)).length;
      assert.ok(
        soloKeys <= otherKeys,
        `solo-local (${soloKeys}) should not be larger than "${name}" (${otherKeys})`,
      );
    }
  });
});

describe('resolveProfile — profile-specific content', () => {
  it('team-github carries a github identity block', () => {
    const seed = resolveProfile('team-github');
    assert.ok(seed.github);
    assert.ok(seed.github.owner);
    assert.ok(seed.github.repo);
  });

  it('qa-only carries a qa harness block', () => {
    const seed = resolveProfile('qa-only');
    assert.ok(seed.qa);
    assert.ok(seed.qa.featureRoot);
  });

  it('audit-only carries an audit-oriented delivery block', () => {
    const seed = resolveProfile('audit-only');
    assert.ok(seed.delivery);
    assert.ok(seed.delivery.codeReview);
  });
});

describe('resolveProfile — error handling', () => {
  it('throws on an unknown profile name', () => {
    assert.throws(
      () => resolveProfile('does-not-exist'),
      /Unknown config profile/,
    );
  });
});
