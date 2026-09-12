/**
 * `/mandrel-plan --yes` headless / non-interactive flag contract after the v2 Stage 3
 * planning-fork cutover.
 *
 * `/mandrel-plan` is workflow prose interpreted by the host LLM, so this spec is a
 * structural assertion over the single authored workflow source. It pins the
 * useful `--yes` semantics that survived the fork removal:
 *
 *   - `/mandrel-plan` is one 3-step path, not an Epic/Story router.
 *   - `--yes` auto-proceeds gate #1 (interrogate confirmation).
 *   - `--yes` auto-proceeds gate #2 (the --force-review pre-persist review).
 *   - `--yes` does not relax deterministic validation gates.
 *   - the retired `deliveryShape` and scope-triage routing fields do not
 *     reappear in the workflow contract.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { assertDocMentions, assertDocOmits } from './helpers/doc-assert.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const WORKFLOWS = path.join(REPO_ROOT, '.agents', 'workflows');

const planSource = readFileSync(
  path.join(WORKFLOWS, 'mandrel-plan.md'),
  'utf8',
);

function section(headingPattern) {
  return (
    planSource.match(
      new RegExp(`${headingPattern}[\\s\\S]*?(?=\\n#{2,3} )`),
    )?.[0] ?? ''
  );
}

describe('/mandrel-plan --yes headless flag — single plan.md path', () => {
  // Story #4760 removed plan.md's flag table: the operator-facing surface is
  // now derived from what they typed, and the flags belong to the self-
  // describing CLIs. `--yes` survives that removal deliberately — it is not an
  // operator convenience but the *unattended* switch, and the behaviours it
  // gates (auto-proceeding both HITL waits; failing an over-scope light prompt
  // closed to an `escalated` terminal) still have to be stated somewhere an
  // agent reads. So the claim is unchanged; only its home moved out of a table.
  it('documents --yes as runner-set, naming both HITL gates it auto-proceeds', () => {
    assertDocMentions(
      planSource,
      /`--yes` is \*\*runner-set, never operator-typed\*\*/,
      'plan.md must keep --yes out of the operator surface without dropping it',
    );
    assertDocMentions(
      planSource,
      /cron, `\/loop`, and headless dispatch set it/,
      '--yes must name who sets it, now that no operator does',
    );
    // Both gates still auto-proceed; each says so at its own gate.
    assert.equal(
      (planSource.match(/Under `--yes`, auto-proceed/g) ?? []).length,
      2,
      'both Gate #1 and Gate #2 must state that --yes auto-proceeds them',
    );
  });

  it('states that /mandrel-plan is a single path and no longer routes by scope verdict', () => {
    assertDocMentions(
      planSource,
      /Single planning path/i,
      'plan.md must declare a single planning path',
    );
    assertDocMentions(
      planSource,
      /there is no Epic\/Story router/i,
      'plan.md must reject the retired Epic/Story router',
    );
    assertDocMentions(
      planSource,
      /no scope-triage `epic\|story` verdict/i,
      'plan.md must reject scope-triage routing verdicts',
    );
  });

  it('defines the three-step Interrogate -> Author -> Persist ceremony', () => {
    assertDocMentions(planSource, /### 1\. Interrogate/);
    assertDocMentions(planSource, /### 2\. Author/);
    assertDocMentions(planSource, /### 3\. Persist/);
  });
});

describe('/mandrel-plan --yes headless flag — gate #1', () => {
  const interrogate = section('### 1\\. Interrogate');

  it('anchors gate #1 at the interrogate confirmation STOP', () => {
    assert.ok(interrogate, 'plan.md must carry the interrogate step');
    assert.match(
      interrogate,
      /\*\*Gate #1\*\*[\s\S]*STOP/i,
      'gate #1 must be an explicit HITL STOP in the interrogate step',
    );
    assert.match(
      interrogate,
      /confirm the sharpened plan intent/i,
      'gate #1 must confirm the sharpened plan intent',
    );
    // Story #5312: duplicates are named on the one advisory line under the
    // gate, never a stop of their own.
    assert.match(
      interrogate,
      /`duplicates\[\]`[\s\S]*one advisory line/i,
      'gate #1 must name duplicates on its advisory line',
    );
  });

  // Prose claims, so they go through doc-assert rather than assert.match:
  // these sentences are hard-wrapped at ~80 columns, and a plain literal space
  // in the pattern silently pins where the wrap falls. Story #4760's trim of
  // this section moved "free-form" onto the next line and turned a correct
  // edit red without changing what the document says.
  it('auto-proceeds under --yes without free-form operator questions', () => {
    assertDocMentions(
      interrogate,
      /Under `--yes`, auto-proceed/i,
      'gate #1 must auto-proceed under --yes',
    );
    assertDocMentions(
      interrogate,
      /do not ask free-form operator questions/i,
      'headless interrogation must not ask operator questions',
    );
    assertDocMentions(
      interrogate,
      /Key Assumptions/,
      'unresolved unknowns must land in the one-pager Key Assumptions section',
    );
  });

  // Story #4845: unknowns are triaged by resolver, not pooled — AFK unknowns
  // get researched even under --yes; only HITL unknowns degrade to Key
  // Assumptions, and those carry the decision-made-by-default marker.
  it('triages unknowns by resolver — AFK researched, HITL-only Key Assumptions', () => {
    assertDocMentions(
      interrogate,
      /AFK.+unknown/i,
      'interrogation must name the AFK unknown class',
    );
    assertDocMentions(
      interrogate,
      /HITL.+unknown/i,
      'interrogation must name the HITL unknown class',
    );
    assertDocMentions(
      interrogate,
      /AFK unknowns are still researched/i,
      '--yes must not exempt AFK unknowns from research',
    );
    assertDocMentions(
      interrogate,
      /only HITL unknowns land in\s+Key Assumptions/i,
      'only HITL unknowns may degrade to Key Assumptions',
    );
    assertDocMentions(
      interrogate,
      /decision-made-by-default/i,
      'defaulted HITL unknowns carry the decision-made-by-default marker',
    );
  });
});

describe('/mandrel-plan --yes headless flag — gate #2', () => {
  const persist = section('### 3\\. Persist');

  it('anchors gate #2 at the --force-review pre-persist review', () => {
    // Story #4542: gate #2 is raised solely by --force-review — the
    // risk-derived routing that used to raise it is gone.
    assert.ok(persist, 'plan.md must carry the persist step');
    assertDocMentions(
      persist,
      /\*\*Gate #2\*\*/,
      'gate #2 must anchor the persist step',
    );
    assertDocOmits(persist, /risk routing/i, 'gate #2 is not risk-routed');
    assertDocMentions(
      persist,
      /`--force-review`/,
      'gate #2 must be raised by --force-review',
    );
    assertDocMentions(
      persist,
      /before persist/i,
      'gate #2 must happen before persist',
    );
  });

  it('auto-proceeds gate #2 under --yes', () => {
    assertDocMentions(
      persist,
      /Under `--yes`, auto-proceed/i,
      'gate #2 must auto-proceed under --yes',
    );
  });
});

describe('/mandrel-plan --yes headless flag — v2 Stage 3 cutover guards', () => {
  it('keeps --yes scoped to HITL waits; deterministic gates still fail closed', () => {
    assertDocMentions(
      planSource,
      /Deterministic gates[\s\S]*still fail closed under `--yes`/i,
      'plan.md must state --yes is not a validation override',
    );
  });

  it('uses the story author prompt and default-single policy instead of deliveryShape routing', () => {
    const author = section('### 2\\. Author');
    assert.ok(author, 'plan.md must carry the author step');
    assertDocMentions(
      author,
      /`stories\.json`[\s\S]*\*\*length 1 by default\*\*/i,
      'authoring must default to one Story',
    );
    assertDocMentions(
      author,
      /Use the envelope `systemPrompts\.story`/i,
      'authoring must consume the story prompt from the envelope',
    );
    assertDocMentions(
      author,
      /Split only under the policy above/i,
      'splitting must be controlled by the default-single policy',
    );
  });

  it('authors no risk verdict at all (Story #4542)', () => {
    // The authored risk verdict — and the deliveryShape field it once carried
    // — are retired. The author step must name neither artifact.
    const author = section('### 2\\. Author');
    assertDocOmits(author, /risk-verdict/i);
    assertDocOmits(author, /deliveryShape/i);
  });

  it('does not link to the deleted planning helpers', () => {
    for (const deleted of [
      'helpers/plan-epic.md',
      'helpers/plan-story.md',
      'helpers/scope-triage-gate.md',
      'helpers/plan-epic-reference.md',
    ]) {
      assertDocOmits(planSource, new RegExp(deleted.replace('.', '\\.')));
    }
  });

  it('keeps scope-triage as optional split-advisory notes only', () => {
    assertDocMentions(
      planSource,
      /optional split-advisory notes only \(no routing verdict\)/i,
      'scope-triage skill link must be advisory-only',
    );
  });
});
