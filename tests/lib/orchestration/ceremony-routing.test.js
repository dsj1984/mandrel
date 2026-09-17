// tests/lib/orchestration/ceremony-routing.test.js
//
// Unit tier (Epic #4478, M7-B, Part 2; re-based on the derived level by Story
// #4542, then off it again by Story #5343): the acceptance-ceremony resolver.
// Pins the profile → verdict-owner table, the degrade of an unrecognised
// profile to `standard`, the absence of any sampling floor (Story #5313
// retired `freshCriticSampleRate` / `sampledFresh`), and — the load-bearing
// invariant since #5343 — that NOTHING about the diff can change the owner.
//
// `derivedLevel` is the level `review-depth.js#deriveChangeLevel` computes
// from the changed-file set ('high' | 'low' | null). It is still derived, and
// **review depth** still reads it; it no longer reaches this resolver's
// decision, so every assertion below sweeps it and expects one answer.

import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  resolveCeremonyForRisk,
  verdictOwnerForMode,
} from '../../../.agents/scripts/lib/orchestration/ceremony-routing.js';

/** Every level shape the resolver may be handed, including the malformed ones. */
const EVERY_LEVEL = ['low', 'high', null, undefined, 'medium', 'bogus'];

describe('resolveCeremonyForRisk — the profile is the whole decision', () => {
  test('minimal → inline self-eval at every derived level', () => {
    for (const derivedLevel of EVERY_LEVEL) {
      const d = resolveCeremonyForRisk({
        derivedLevel,
        ceremonyProfile: 'minimal',
      });
      assert.equal(d.mode, 'inline');
      assert.equal(d.profile, 'minimal');
      assert.equal(d.verdictOwner, 'inline-self-eval');
      assert.equal('sampled' in d, false);
    }
  });

  test('standard (the default) → inline self-eval at every derived level', () => {
    // Story #5343 — `high` and the underivable fail-safe used to route fresh
    // here. A frontier worker scoring its own criteria is now the default,
    // and a sensitive path escalates REVIEW DEPTH instead.
    for (const derivedLevel of EVERY_LEVEL) {
      const explicit = resolveCeremonyForRisk({
        derivedLevel,
        ceremonyProfile: 'standard',
      });
      const defaulted = resolveCeremonyForRisk({ derivedLevel });
      assert.equal(explicit.mode, 'inline');
      assert.equal(explicit.verdictOwner, 'inline-self-eval');
      assert.equal(explicit.profile, 'standard');
      assert.deepEqual(defaulted, explicit);
    }
  });

  test('strict → fresh-context critic at every derived level', () => {
    for (const derivedLevel of EVERY_LEVEL) {
      const d = resolveCeremonyForRisk({
        derivedLevel,
        ceremonyProfile: 'strict',
      });
      assert.equal(d.mode, 'fresh');
      assert.equal(d.profile, 'strict');
      assert.equal(d.verdictOwner, 'fresh-critic');
      assert.equal('sampled' in d, false);
    }
  });

  test('an unrecognised or absent profile degrades to standard', () => {
    for (const input of [
      undefined,
      null,
      {},
      { ceremonyProfile: null },
      { ceremonyProfile: 'paranoid' },
      { ceremonyProfile: 7 },
    ]) {
      const d = resolveCeremonyForRisk(input ?? undefined);
      assert.equal(d.profile, 'standard', `for ${JSON.stringify(input)}`);
      assert.equal(d.mode, 'inline');
    }
  });

  test('every resolution carries a reason naming its profile', () => {
    for (const profile of ['minimal', 'standard', 'strict']) {
      const d = resolveCeremonyForRisk({ ceremonyProfile: profile });
      assert.match(d.reason, new RegExp(profile));
    }
  });

  test('retired inputs (freshCriticSampleRate, clusterIndex) change nothing', () => {
    const baseline = resolveCeremonyForRisk({ ceremonyProfile: 'standard' });
    for (const clusterIndex of [0, 1, 5, 10]) {
      assert.deepEqual(
        resolveCeremonyForRisk({
          ceremonyProfile: 'standard',
          clusterIndex,
          freshCriticSampleRate: 1,
        }),
        baseline,
      );
    }
  });
});

describe('single verdict-owner per Story (Story #4723, narrowed by #5343)', () => {
  // Acceptance verification runs ONE verdict-owner per Story — the fresh
  // critic under `strict`, the inline self-eval otherwise. The resolved
  // decision names that owner explicitly, and it is always exactly one of the
  // two authoring passes; `acceptance-eval.js` is the deterministic scorer of
  // that verdict, never a third owner.
  test('verdictOwnerForMode maps each mode to its single owner', () => {
    assert.equal(verdictOwnerForMode('fresh'), 'fresh-critic');
    assert.equal(verdictOwnerForMode('inline'), 'inline-self-eval');
  });

  test('every resolution names exactly one owner, aligned with its mode', () => {
    for (const ceremonyProfile of [
      undefined,
      'minimal',
      'standard',
      'strict',
    ]) {
      for (const derivedLevel of EVERY_LEVEL) {
        const d = resolveCeremonyForRisk({ derivedLevel, ceremonyProfile });
        assert.ok(
          d.verdictOwner === 'fresh-critic' ||
            d.verdictOwner === 'inline-self-eval',
          `owner must be one of the two authoring passes, got ${d.verdictOwner}`,
        );
        assert.equal(d.verdictOwner, verdictOwnerForMode(d.mode));
      }
    }
  });
});

describe('HARD INVARIANT — the diff never changes the verdict owner', () => {
  // The decision is a pure function of the profile. Story #5343 made that the
  // point rather than an implementation detail: a Story cannot buy itself a
  // different owner by what it touched, in either direction.
  for (const ceremonyProfile of ['minimal', 'standard', 'strict']) {
    test(`${ceremonyProfile}: one identical decision across every level`, () => {
      const decisions = EVERY_LEVEL.map((derivedLevel) =>
        resolveCeremonyForRisk({ derivedLevel, ceremonyProfile }),
      );
      for (const decision of decisions) {
        assert.deepEqual(decision, decisions[0]);
      }
    });
  }
});
