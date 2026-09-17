/**
 * tests/bootstrap/workflow-invocation-surface.test.js — the operator-facing
 * invocation surface of `/mandrel-plan` and `/mandrel-deliver` (Story #4760).
 *
 * ## What this pins
 *
 * Two commands an operator can type from memory. The routing decisions that
 * used to live in the invocation — which delivery path, which plan mode, which
 * merge behaviour — now live in the workflows, derived from argument shape and
 * live state. These assertions exist because that surface is prose: nothing
 * else fails when a `## Flags` table creeps back or a retired command name
 * survives in a doc.
 *
 * The negative assertions are the load-bearing half. A flag table is easy to
 * re-add "just for reference", and each one re-imposes the memory burden the
 * change removed.
 *
 * Prose assertions go through `doc-assert.js` so a re-flowed 80-column
 * paragraph cannot turn a correct edit red (and, for the negative cases, so a
 * forbidden phrase cannot hide by straddling a line break).
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  assertDocMentions,
  assertDocOmits,
  readDoc,
} from '../helpers/doc-assert.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

const rel = (p) => path.join(REPO_ROOT, p);

const DELIVER = rel('.agents/workflows/mandrel-deliver.md');
const PLAN = rel('.agents/workflows/mandrel-plan.md');
const LIGHT = rel('.agents/workflows/helpers/deliver-light.md');
const DELIVER_REF = rel('.agents/workflows/helpers/deliver-reference.md');
const PLAN_REF = rel('.agents/workflows/helpers/plan-reference.md');

describe('one delivery door (Story #4760)', () => {
  it('retires the top-level /deliver-light workflow into helpers/', () => {
    assert.equal(
      existsSync(rel('.agents/workflows/deliver-light.md')),
      false,
      'a top-level deliver-light.md projects a /deliver-light command again — ' +
        'the whole point is one delivery door',
    );
    assert.equal(
      existsSync(LIGHT),
      true,
      'the prompt path must survive the move as a helper — it has two callers',
    );
  });

  it('drops /deliver-light from the generated workflow index', () => {
    // The index is generated from top-level workflow front-matter, so this
    // also proves the move (not a hand-edit) did the retirement.
    assertDocOmits(
      readDoc(rel('.agents/docs/workflows.md')),
      /\/deliver-light/,
      'the generated command index still advertises a command that no longer projects',
    );
  });

  it('documents all three /mandrel-deliver input shapes and the mixed-input refusal', () => {
    const md = readDoc(DELIVER);
    assertDocMentions(
      md,
      /\^#\?\\d\+\$/,
      'the id discriminator must be stated exactly',
    );
    assertDocMentions(
      md,
      /bare/i,
      'a bare invocation must have a documented behaviour, not be undefined',
    );
    // Story #5341 — a mixed invocation is ambiguous, not fatal. The rule it
    // replaced made the router refuse work a one-line question resolves, and
    // the guard that matters is unchanged: the shape is never silently
    // guessed.
    assertDocMentions(
      md,
      /mixed[^.]*ambiguous, not fatal/i,
      'mixed ids-and-prose must be disambiguated rather than guessed at',
    );
    assertDocMentions(
      md,
      /ask which was meant/i,
      'the router must say how to disambiguate, not merely that it is ambiguous',
    );
    assertDocMentions(
      md,
      /helpers\/deliver-light\.md/,
      '/mandrel-deliver must route the prompt shape into the shared helper',
    );
  });

  it('keeps escalation terminal for the light path — /mandrel-deliver still never plans (Story #5344)', () => {
    const md = readDoc(DELIVER);
    assertDocMentions(
      md,
      /`\/mandrel-deliver` never plans/i,
      'the one delivery door must not grow a planning branch',
    );
    assertDocMentions(
      md,
      /seeded with `escalation\.reasons`/i,
      'Story #5344 replaced the in-session ban with a seeding contract; the ' +
        'constraint must name it rather than a rule that no longer holds',
    );
  });
});

describe('derived invocation intent (Story #4760)', () => {
  for (const [label, file] of [
    ['deliver.md', DELIVER],
    ['plan.md', PLAN],
  ]) {
    it(`${label} carries no operator-facing flag table`, () => {
      const md = readFileSync(file, 'utf8');
      // Heading match, not prose: a `## Flags` section is a layout claim.
      assert.doesNotMatch(
        md,
        /^##+\s+Flags\s*$/m,
        `${label} reintroduced a flag table — the flags belong to the scripts, ` +
          'which document themselves via --help',
      );
    });

    it(`${label} documents --yes as runner-set, never operator-typed`, () => {
      assertDocMentions(
        readDoc(file),
        /`--yes` is \*\*runner-set, never operator-typed\*\*/,
        `${label} must keep --yes out of the operator's hands without deleting it: ` +
          'it is the unattended switch the escalation guarantee depends on',
      );
    });
  }

  it('plan.md derives a bare id from live state and announces it', () => {
    const md = readDoc(PLAN);
    assertDocMentions(
      md,
      /`agent::done` can only be amended/,
      'the amend-vs-tickets ambiguity must resolve from state, not a flag',
    );
    assertDocMentions(
      md,
      /Announce the derivation/i,
      'a derived mode must be announced so a wrong read costs one correction',
    );
    assertDocMentions(
      md,
      /Ask \*\*only\*\* for an open Story already at `agent::ready`/,
      'the one genuinely ambiguous case must still ask',
    );
  });

  it('deliver-reference.md maps intent phrases to the flags they fill in', () => {
    const md = readDoc(DELIVER_REF);
    assertDocMentions(
      md,
      /Intent phrases/,
      'the replacement for the flag table must exist',
    );
    assertDocMentions(
      md,
      /--no-wait-merge/,
      'the merge-it-myself intent must name the flag it fills in',
    );
    assertDocMentions(
      md,
      /Silence means config, not a literal/,
      'omitting --concurrency is what lets .agentrc.local.json win; filling in the ' +
        'default as a literal silently defeats the override',
    );
  });

  it('plan-reference.md orders the input-mode derivation unambiguously', () => {
    assertDocMentions(
      readDoc(PLAN_REF),
      /Test \*file exists\* before \*looks like prose\*/,
      'without an explicit order a bare notes.md becomes a one-word seed',
    );
  });

  // Story #4815 added --operator-proceed-light to the light gate. It is an
  // answer the AGENT relays on the operator's behalf inside the helper, not
  // something an operator types at the door — and a gate flag surfacing on the
  // invocation surface is how the retired flag table grew the first time.
  it('keeps the light gate flags off the two operator-facing doors', () => {
    for (const [label, file] of [
      ['deliver.md', DELIVER],
      ['plan.md', PLAN],
    ]) {
      assert.doesNotMatch(
        readFileSync(file, 'utf8'),
        /--operator-proceed-light/,
        `${label} names a deliver-light gate flag — the suitability gate's flags ` +
          "belong to helpers/deliver-light.md and the script's own --help",
      );
    }
  });
});

describe('the light → /mandrel-plan escalation (Story #4760; one-way since #5312)', () => {
  it('states what escalation ends, and what it does not (Story #5344)', () => {
    const md = readDoc(LIGHT);
    assertDocMentions(
      md,
      /envelope IS this session's terminal output for the light path/i,
      'the light path still ends at the envelope — only the session ban lifted',
    );
    assertDocMentions(
      md,
      /no receipt Story, no `story-<id>` branch, and no worktree/i,
      'an escalated run must still be stated to have started nothing',
    );
  });

  it('no longer names /mandrel-plan Gate #1 as a door (Story #5312)', () => {
    assertDocOmits(
      readDoc(LIGHT),
      /Entered from `\/mandrel-plan` Gate #1/,
      'the Gate #1 light suggestion is retired',
    );
    assertDocOmits(
      readDoc(PLAN),
      /deliverLightSuggestion|route \*\*in this session\*\* into/,
      '/mandrel-plan makes no light offer',
    );
  });

  it('permits the escalating session to continue, seeded, and names what re-decides it (Story #5344)', () => {
    const md = readDoc(LIGHT);
    assertDocMentions(
      md,
      /in this same session/i,
      'the loosening must be stated where the escalation is described',
    );
    assertDocMentions(
      md,
      /`escalation\.reasons`/,
      'continuing in-session is only safe with the seeding contract attached',
    );
    assertDocMentions(
      md,
      /fresh session is still the safer default/i,
      'the fresh-session alternative must survive as the recommendation',
    );
    assertDocMentions(
      md,
      /light-arm cell of mandrel-bench/i,
      'the empirical finding must keep a named measurement that can re-decide it',
    );
  });

  it('names its one caller on the shared helper', () => {
    const md = readDoc(LIGHT);
    assertDocMentions(
      md,
      /There is no `\/deliver-light` to type/,
      'it is a path, not a command',
    );
    assertDocMentions(
      md,
      /reached one way/,
      'the single-caller framing survives the retired Gate #1 door (Story #5312)',
    );
  });
});
