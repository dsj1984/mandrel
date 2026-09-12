/**
 * tests/workflows/deliver-digest.test.js — Story #4736, AC-5.
 *
 * The deliver path used to re-read the same helper/schema set every session —
 * nine separate reads on one measured delivery, each one growing the resident
 * context every later turn re-pays. `helpers/deliver-digest.md` is the single
 * bundled read that replaces them.
 *
 * A digest only earns its existence if two things stay true, and neither is
 * self-enforcing:
 *
 *   1. It **covers** what the engine always needs. A digest missing the
 *      terminal statuses or the acceptance gate sends the reader back to the
 *      files it was meant to replace — worse than no digest, because it is
 *      paid for AND bypassed.
 *   2. It stays **bounded**. The failure mode for a bundle is accretion: it
 *      absorbs situational material until it is as expensive as the reads it
 *      replaced. The ceiling makes that regression a red test rather than a
 *      slow drift.
 *
 * And the spine files must actually point at it, or nothing routes through it.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { resolveCeremonyForRisk } from '../../.agents/scripts/lib/orchestration/ceremony-routing.js';
import { deriveChangeLevel } from '../../.agents/scripts/lib/orchestration/review-depth.js';
import { assertDocMentions, assertDocOmits } from '../helpers/doc-assert.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const WORKFLOWS = path.join(REPO_ROOT, '.agents', 'workflows');
const DIGEST = path.join(WORKFLOWS, 'helpers', 'deliver-digest.md');

/**
 * Ceiling for the bundle. Comfortably above what the always-needed material
 * costs today and far below the ~5× that re-reading the individual files did.
 *
 * Raised from 8 KiB to 9 KiB by Story #5174, which folded the crediting
 * full-suite invocation (§ 5) into the bundle. That is not the accretion this
 * ceiling exists to catch: the invocation is material **every** delivery
 * needs, and leaving it only in `deliver-story-reference.md` meant a
 * dispatched worker never read it and close paid for the suite twice. The
 * anti-accretion rule is unchanged — situational material still belongs in
 * the reference files, not here.
 */
const DIGEST_BUDGET_BYTES = 9 * 1024;

const read = (p) => readFileSync(p, 'utf8');

describe('helpers/deliver-digest.md — the one bundled deliver read (AC-5)', () => {
  it('covers every always-needed surface the engine would otherwise re-read', () => {
    const digest = read(DIGEST);
    /** [what the reader came for, a token that proves it is actually here] */
    const coverage = [
      ['the dispatch decision', 'dispatchMode'],
      ['the single-Story inline rule', 'one-Story run'],
      ['the branch/merge invariants', 'story-<id>'],
      ['the change-set-once discipline', 'computed once'],
      ['the scripted ceremony derivation', 'ceremony-derive.js'],
      ['the derivation envelope fields', 'verdictOwner'],
      ['the acceptance gate invocation', 'acceptance-eval.js'],
      ['the one full-suite run', 'npm test'],
      ['the terminal envelope marker', '--- STORY DELIVER TERMINAL ---'],
      ['the state-transition command', 'update-ticket-state.js'],
    ];
    for (const [surface, token] of coverage) {
      assert.ok(
        digest.includes(token),
        `the digest no longer covers ${surface} (missing "${token}") — a reader hitting that gap falls back to the per-file reads the digest exists to replace`,
      );
    }
    for (const status of ['landed', 'pending', 'blocked', 'failed']) {
      assert.ok(
        digest.includes(`\`${status}\``),
        `the digest omits the "${status}" terminal status, so a caller cannot branch on the envelope without opening the schema`,
      );
    }
  });

  it('stays inside its byte budget', () => {
    const bytes = Buffer.byteLength(read(DIGEST), 'utf8');
    assert.ok(
      bytes <= DIGEST_BUDGET_BYTES,
      `deliver-digest.md is ${bytes} bytes, over the ${DIGEST_BUDGET_BYTES}-byte budget — situational material belongs in deliver-story-reference.md / deliver-reference.md, not the always-read bundle`,
    );
  });

  it('is reachable from both deliver spines', () => {
    for (const spine of [
      path.join(WORKFLOWS, 'mandrel-deliver.md'),
      path.join(WORKFLOWS, 'helpers', 'deliver-story.md'),
    ]) {
      assert.ok(
        read(spine).includes('deliver-digest.md'),
        `${path.relative(REPO_ROOT, spine)} does not link the digest — an unreferenced bundle is paid for by nobody and read by nobody`,
      );
    }
  });

  it('the spine cites the digest instead of restating the terminal table', () => {
    const spine = read(path.join(WORKFLOWS, 'helpers', 'deliver-story.md'));
    assert.ok(
      spine.includes('digest § 6'),
      'deliver-story.md must route Step 3 / Step 7 at the digest, not carry its own copy of the status table',
    );
  });
});

describe('helpers/deliver-story.md — the orphaned-envelope fallback (#4816)', () => {
  const read = (p) => readFileSync(p, 'utf8');
  const spine = () => read(path.join(WORKFLOWS, 'helpers', 'deliver-story.md'));

  it('sends an envelope-less child turn to the persisted file first', () => {
    // Persisting the envelope buys nothing unless the router is told to read
    // it: the whole cost this removes is the recovery round trip a caller
    // pays when a worker's turn ended before it could relay.
    assertDocMentions(
      spine(),
      /temp\/orchestration\/story-deliver-terminal-<storyId>\.json/,
      'deliver-story.md must name the persisted envelope path',
    );
    assertDocMentions(
      spine(),
      /[Ll]ost envelope first: read it off disk/,
      'the fallback must come BEFORE the recovery probe, not as a footnote to it',
    );
  });

  it('warns that a live close must not be re-initialized underneath', () => {
    assertDocMentions(
      spine(),
      /close-in-flight/,
      'deliver-story.md must name the shape the probe now returns for a live close',
    );
    assertDocMentions(
      spine(),
      /never re-init underneath it/i,
      'the hazard (two closes racing one PR) must be stated where the operator reads it',
    );
  });
});

describe('deliver-digest § 3 — the ceremony derivation is scripted (#5313)', () => {
  // § 3 used to hand the worker a three-module import block, and the
  // object-for-string `derivedLevel` slip routed low-risk Stories to the null
  // fail-safe with no error to attribute the cost to. The block is gone: the
  // digest cites `ceremony-derive.js`, which computes the composition itself.
  const digest = () => read(DIGEST);

  it('AC-3: cites ceremony-derive.js and carries no --input-type=module block', () => {
    for (const [label, file] of [
      ['the digest', DIGEST],
      [
        'the self-eval helper',
        path.join(WORKFLOWS, 'helpers', 'acceptance-self-eval.md'),
      ],
      [
        'the story-worker context',
        path.join(REPO_ROOT, '.agents', 'agents', 'story-worker.md'),
      ],
    ]) {
      const doc = read(file);
      assertDocMentions(
        doc,
        /ceremony-derive\.js --story <storyId>/,
        `${label} must cite the scripted derivation`,
      );
      assertDocOmits(
        doc,
        /--input-type=module/,
        `${label} must carry no hand-carried import block`,
      );
      assertDocOmits(
        doc,
        /freshCriticSampleRate|sampling floor/,
        `${label} must not describe the retired sampling floor`,
      );
    }
  });

  it('names every field the derivation prints', () => {
    for (const field of [
      'files',
      'level',
      'classes',
      'mode',
      'reason',
      'verdictOwner',
    ]) {
      assert.ok(
        digest().includes(`\`${field}\``),
        `the digest must name the ${field} field of the derivation envelope`,
      );
    }
  });

  it('the documented composition still resolves a real mode from a real level', () => {
    const derived = deriveChangeLevel({
      changedFiles: ['docs/onboarding.md', 'README.md'],
    });
    const ceremony = resolveCeremonyForRisk({
      derivedLevel: derived.level,
      clusterIndex: 0,
    });
    assert.notEqual(derived.level, null);
    assert.ok(ceremony.mode === 'fresh' || ceremony.mode === 'inline');
    assert.equal(
      ceremony.verdictOwner,
      ceremony.mode === 'fresh' ? 'fresh-critic' : 'inline-self-eval',
    );
  });

  it('routes the object-for-string mistake to the null fail-safe, never a low verdict', () => {
    const derived = deriveChangeLevel({
      changedFiles: ['docs/onboarding.md'],
      selectSensitivePathClassesFn: () => [],
    });
    assert.equal(derived.level, 'low');
    const documented = resolveCeremonyForRisk({
      derivedLevel: derived.level,
      clusterIndex: 1,
    });
    const mistaken = resolveCeremonyForRisk({
      derivedLevel: derived,
      clusterIndex: 1,
    });
    assert.equal(documented.mode, 'inline');
    assert.equal(mistaken.mode, 'fresh');
    assert.match(mistaken.reason, /underivable/);
  });
});

describe('deliver-digest § 5 — the one full-suite run (#5174, #5313)', () => {
  const digest = () => read(DIGEST);
  const spine = () => read(path.join(WORKFLOWS, 'helpers', 'deliver-story.md'));
  const worker = () =>
    read(path.join(REPO_ROOT, '.agents', 'agents', 'story-worker.md'));

  it('AC-5: names a bare npm test as the credited run and carries no invocation-shape rules', () => {
    for (const [label, doc] of [
      ['the digest', digest()],
      ['the story-worker context', worker()],
    ]) {
      assertDocMentions(doc, /npm test/, `${label} must name the runner`);
      assertDocOmits(
        doc,
        /deposits \*{0,2}no\*{0,2}\*{0,2}ne?\*{0,2} credit|deposits \*\*none\*\*/,
        `${label} must not say a bare run deposits no credit`,
      );
      assertDocOmits(
        doc,
        /coverage-capture\.js --cwd|evidence-gate\.js --standalone[^\n]*--gate test/,
        `${label} must not carry the retired crediting invocations`,
      );
      assertDocOmits(
        doc,
        /(before|after) the push/,
        `${label} must carry no push-before-capture ordering rule`,
      );
    }
  });

  it('places the run after the last fix commit', () => {
    for (const [label, doc] of [
      ['the digest', digest()],
      ['the spine', spine()],
    ]) {
      assertDocMentions(
        doc,
        /last fix commit/,
        `${label} must anchor the run to the loop's last fix commit`,
      );
    }
  });

  it('the spine points at the digest rather than restating the run', () => {
    assertDocMentions(
      spine(),
      /digest § 5/,
      'deliver-story.md Step 2.5 must route the run at the digest',
    );
    assert.ok(
      !spine().includes('coverage-capture.js'),
      'the spine must not carry a crediting invocation',
    );
  });

  it('states the verify[] reuse rule so the suite is not spawned a third time', () => {
    assertDocMentions(
      digest(),
      /full-suite command is reported credited against the same record, never\s+respawned/,
      'the digest must state that a full-suite verify[] entry is credited, not respawned',
    );
  });
});
