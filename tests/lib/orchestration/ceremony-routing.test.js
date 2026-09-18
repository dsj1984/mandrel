// tests/lib/orchestration/ceremony-routing.test.js
//
// Unit tier (Epic #4478, M7-B, Part 2; re-based on the derived level by Story
// #4542, off it again by Story #5343, and narrowed to it by Story #5366): the
// acceptance-ceremony resolver.
//
// Three things are pinned here:
//
//   1. **The output table (Story #5366 AC-2).** `PINNED_DECISIONS` is the
//      current release's profile → { mode, verdictOwner } mapping, written out
//      literally rather than computed, so the surface reduction that narrowed
//      the resolver's signature cannot also have moved an answer. A change to
//      any cell has to be made here, deliberately.
//   2. **The signature (Story #5366 AC-1).** The resolver reads the ceremony
//      profile and nothing else, and its documented `@param` shape names
//      nothing else either — `derivedLevel` and `clusterIndex` used to be
//      accepted "for call-site compatibility" against call sites that no
//      longer existed.
//   3. **Totality.** An absent, malformed or unrecognised profile degrades to
//      `standard` rather than throwing.
//
// The derived change level (`review-depth.js#deriveChangeLevel`) is still
// computed and still printed by `ceremony-derive.js` — **review depth** reads
// it. It is simply not an input to this decision.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test, { describe } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  resolveCeremonyForRisk,
  verdictOwnerForMode,
} from '../../../.agents/scripts/lib/orchestration/ceremony-routing.js';

const MODULE_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../.agents/scripts/lib/orchestration/ceremony-routing.js',
);

/**
 * The current release's decision table, written literally. This is the
 * regression pin: the Story #5366 surface reduction is a signature change, and
 * an output change would be a behaviour change it was not licensed to make.
 */
const PINNED_DECISIONS = Object.freeze({
  minimal: { mode: 'inline', verdictOwner: 'inline-self-eval' },
  standard: { mode: 'inline', verdictOwner: 'inline-self-eval' },
  strict: { mode: 'fresh', verdictOwner: 'fresh-critic' },
});

/** The profile an absent / unrecognised value must degrade to. */
const DEFAULT_PROFILE = 'standard';

describe('AC-2 — the decision table is unchanged for every profile', () => {
  for (const [profile, expected] of Object.entries(PINNED_DECISIONS)) {
    test(`${profile} → ${expected.mode} / ${expected.verdictOwner}`, () => {
      const d = resolveCeremonyForRisk({ ceremonyProfile: profile });
      assert.equal(d.profile, profile);
      assert.equal(d.mode, expected.mode);
      assert.equal(d.verdictOwner, expected.verdictOwner);
      // The reason is prose and free to be re-worded, but it must name the
      // profile it came from — that is what makes an envelope auditable.
      assert.match(d.reason, new RegExp(profile));
    });
  }

  test('the resolved shape carries exactly the four documented fields', () => {
    for (const profile of Object.keys(PINNED_DECISIONS)) {
      assert.deepEqual(
        Object.keys(
          resolveCeremonyForRisk({ ceremonyProfile: profile }),
        ).sort(),
        ['mode', 'profile', 'reason', 'verdictOwner'],
      );
    }
  });

  test('no sampling residue survives on any decision', () => {
    for (const profile of Object.keys(PINNED_DECISIONS)) {
      const d = resolveCeremonyForRisk({ ceremonyProfile: profile });
      assert.equal('sampled' in d, false);
      assert.equal('sampledFresh' in d, false);
    }
  });
});

describe('AC-1 — the signature accepts only what it reads', () => {
  test('the documented @param shape names ceremonyProfile alone', () => {
    const source = readFileSync(MODULE_PATH, 'utf8');
    const marker = 'export function resolveCeremonyForRisk';
    const declaration = source.indexOf(marker);
    assert.ok(declaration > 0, 'resolveCeremonyForRisk must be exported');

    // The JSDoc block immediately above the declaration is the documented
    // shape — the thing a caller reads before deciding what to pass.
    const docStart = source.lastIndexOf('/**', declaration);
    const doc = source.slice(docStart, declaration);
    assert.match(doc, /ceremonyProfile\?:/);
    for (const retired of ['derivedLevel', 'clusterIndex']) {
      assert.equal(
        doc.includes(retired),
        false,
        `${retired} must not survive in the documented shape`,
      );
    }
  });

  test('the module body reads no other input', () => {
    const source = readFileSync(MODULE_PATH, 'utf8');
    const body = source.slice(
      source.indexOf('export function verdictOwnerForMode'),
    );
    for (const retired of ['derivedLevel', 'clusterIndex']) {
      assert.equal(
        body.includes(retired),
        false,
        `${retired} must not be referenced by the implementation`,
      );
    }
  });

  test('the diff cannot reach the decision even when a caller volunteers it', () => {
    // A stale call site passing the old keys gets the profile's answer, not a
    // different one — the reduction is not a behaviour change in disguise.
    for (const profile of Object.keys(PINNED_DECISIONS)) {
      const baseline = resolveCeremonyForRisk({ ceremonyProfile: profile });
      for (const derivedLevel of ['low', 'high', null, 'bogus']) {
        assert.deepEqual(
          resolveCeremonyForRisk({
            ceremonyProfile: profile,
            derivedLevel,
            clusterIndex: 3,
          }),
          baseline,
          `${profile} must be unmoved by derivedLevel=${derivedLevel}`,
        );
      }
    }
  });
});

describe('totality — malformed input degrades, never throws', () => {
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
      assert.equal(d.profile, DEFAULT_PROFILE, `for ${JSON.stringify(input)}`);
      assert.deepEqual(
        { mode: d.mode, verdictOwner: d.verdictOwner },
        PINNED_DECISIONS[DEFAULT_PROFILE],
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
      const d = resolveCeremonyForRisk({ ceremonyProfile });
      assert.ok(
        d.verdictOwner === 'fresh-critic' ||
          d.verdictOwner === 'inline-self-eval',
        `owner must be one of the two authoring passes, got ${d.verdictOwner}`,
      );
      assert.equal(d.verdictOwner, verdictOwnerForMode(d.mode));
    }
  });
});
