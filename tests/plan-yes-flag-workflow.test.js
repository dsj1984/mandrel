/**
 * `/plan --yes` headless / non-interactive flag contract (Story #4223,
 * re-anchored to the 3-step collapse — Epic #4474 PR5).
 *
 * `--yes` deterministically auto-proceeds the two `/plan` HITL STOP gates
 * without waiting for operator input:
 *
 *   - **Gate #1** — the exit of the interrogate step (one-pager /
 *     scope-triage / clarity-refinement confirm on the Epic path; the
 *     draft confirm on the Story path).
 *   - **Gate #2** — the risk-routed pre-persist review on the Epic path.
 *
 * `/plan` is workflow PROSE interpreted by the host LLM — there is no Node
 * CLI arg parser for it. So this spec is a STRUCTURAL assertion over the
 * authored workflow sources — it does not execute the workflow, it pins the
 * load-bearing contract that the flag is:
 *
 *   1. documented in the `plan.md` flag table and surfaced in `/plan` usage,
 *   2. wired at gate #1 (interrogate exit) in both path helpers,
 *   3. wired at gate #2 (pre-persist review) in the Epic path helper,
 *   4. composed with `--allow-over-budget` and the risk-routed gate #2 skip,
 *   5. scoped to the HITL waits only (it does not relax deterministic gates),
 *   6. bounded at interrogate: exactly one pass, no operator questions,
 *      unresolved unknowns land in Key Assumptions (headless can never hang),
 *   7. and leaves default (no-flag) behavior unchanged (the STOPs remain).
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const WORKFLOWS = path.join(REPO_ROOT, '.agents', 'workflows');

const planSource = readFileSync(path.join(WORKFLOWS, 'plan.md'), 'utf8');
const epicSource = readFileSync(
  path.join(WORKFLOWS, 'helpers', 'plan-epic.md'),
  'utf8',
);
const storySource = readFileSync(
  path.join(WORKFLOWS, 'helpers', 'plan-story.md'),
  'utf8',
);
// Story #4341 single-homed the scope-triage gate semantics (verdict meanings,
// the three-way choice, the --yes resolution, the no-re-triage rule) into this
// shared fragment. The Epic path's interrogate step and plan-story Phase 2
// REFERENCE it and keep only their path-specific firing conditions.
const gateFragmentSource = readFileSync(
  path.join(WORKFLOWS, 'helpers', 'scope-triage-gate.md'),
  'utf8',
);

function headlessSection() {
  return (
    planSource.match(
      /###\s+Headless \/ non-interactive mode[\s\S]*?(?=\n## )/,
    )?.[0] ?? ''
  );
}

describe('/plan --yes headless flag — plan.md router', () => {
  it('documents --yes in the flag table as a both-path flag', () => {
    const flagRow = planSource
      .split('\n')
      .find((line) => /^\|\s*`--yes`\s*\|/.test(line));
    assert.ok(flagRow, 'plan.md flag table must carry a `--yes` row');
    assert.match(
      flagRow,
      /\|\s*both\s*\|/,
      '`--yes` must apply to both the Epic and Story paths',
    );
    assert.match(
      flagRow,
      /non-interactive|headless/i,
      '`--yes` row must describe the non-interactive / headless intent',
    );
  });

  it('surfaces a dedicated headless / non-interactive mode section', () => {
    assert.match(
      planSource,
      /###\s+Headless \/ non-interactive mode \(`--yes`\)/,
      'plan.md must carry a "Headless / non-interactive mode (`--yes`)" section',
    );
  });

  it('names both HITL STOP gates the flag auto-proceeds', () => {
    const section = headlessSection();
    assert.match(
      section,
      /gate #1/i,
      'headless section must name gate #1 (interrogate exit)',
    );
    assert.match(
      section,
      /gate #2/i,
      'headless section must name gate #2 (risk-routed pre-persist review)',
    );
    assert.match(
      section,
      /interrogate/i,
      'gate #1 must be anchored to the exit of the interrogate step',
    );
    assert.match(
      section,
      /risk-routed pre-persist review|before the persist/i,
      'gate #2 must be described as the risk-routed pre-persist review',
    );
  });

  it('specifies the bounded-interrogation headless contract', () => {
    const section = headlessSection();
    assert.match(
      section,
      /exactly one bounded pass/i,
      'the interrogation must run exactly one bounded pass under --yes',
    );
    assert.match(
      section,
      /no operator questions are asked/i,
      'no operator questions may be asked under --yes',
    );
    assert.match(
      section,
      /Key Assumptions/,
      'unresolved unknowns must land in the one-pager Key Assumptions section',
    );
    assert.match(
      section,
      /can never hang/i,
      'the contract must state a headless driver can never hang',
    );
  });

  it('documents composition with --allow-over-budget and the risk-routed gate #2 skip', () => {
    const section = headlessSection();
    assert.match(
      section,
      /--allow-over-budget/,
      'headless section must document composition with --allow-over-budget',
    );
    assert.match(
      section,
      /risk-routed gate #2 skip/i,
      'headless section must document composition with the risk-routed gate #2 skip',
    );
  });

  it('scopes --yes to the HITL waits only (deterministic gates still run)', () => {
    const section = headlessSection();
    assert.match(
      section,
      /does\s+\*\*not\*\*\s+relax any deterministic gate|not a validation\s+override/i,
      'headless section must state --yes does not relax deterministic gates',
    );
    assert.match(
      section,
      /agent::blocked/,
      'headless section must affirm the agent::blocked runtime pause is unaffected',
    );
  });

  it('keeps default (no-flag) behavior unchanged', () => {
    const flagRow = planSource
      .split('\n')
      .find((line) => /^\|\s*`--yes`\s*\|/.test(line));
    assert.match(
      flagRow,
      /Default \(flag absent\) behavior is unchanged/i,
      '`--yes` row must affirm default behavior is unchanged',
    );
  });

  it('forwards --yes through the delegate step of the procedure', () => {
    assert.match(
      planSource,
      /forwarding the absorbed flags \(including `--yes`\)/,
      'the Procedure delegate step must forward --yes to the path helper',
    );
  });
});

describe('/plan --yes headless flag — gate #1 (exit of interrogate)', () => {
  const gate1 =
    epicSource.match(
      /### Gate #1 — exit of interrogate[\s\S]*?(?=\n## Step 2)/,
    )?.[0] ?? '';

  it('anchors gate #1 at the exit of the Epic-path interrogate step', () => {
    assert.ok(
      gate1,
      'plan-epic must carry a "Gate #1 — exit of interrogate" HITL STOP section',
    );
    assert.match(
      gate1,
      /\*\*STOP\*\*/,
      'gate #1 must be an explicit HITL STOP',
    );
  });

  it('folds every interrogate outcome into the single gate #1 confirm', () => {
    assert.match(
      gate1,
      /one-pager|refined-body diff/i,
      'gate #1 must fold in the one-pager / refined-body confirm',
    );
    assert.match(
      gate1,
      /scope-triage verdict/i,
      'gate #1 must fold in the scope-triage verdict',
    );
    assert.match(
      gate1,
      /duplicate candidates/i,
      'gate #1 must fold in the duplicate-candidate review',
    );
    assert.match(
      gate1,
      /re-plan decision/i,
      'gate #1 must fold in the re-plan decision',
    );
  });

  it('carries the --yes auto-proceed + bounded-pass note at gate #1', () => {
    assert.match(
      gate1,
      /`--yes`[\s\S]*does \*\*not\*\*\s*\n?>?\s*STOP/i,
      'gate #1 --yes note must state the gate does not STOP',
    );
    assert.match(
      gate1,
      /one bounded pass/i,
      'gate #1 --yes note must bound the interrogation to one pass',
    );
    assert.match(
      gate1,
      /Key Assumptions/,
      'gate #1 --yes note must route unknowns into Key Assumptions',
    );
  });

  it('resolves a story/borderline verdict to the Recommended branch under --yes', () => {
    assert.match(
      gate1,
      /Recommended/,
      'gate #1 --yes note must resolve triage to the Recommended branch',
    );
    // The shared --yes → Recommended contract, with --yes propagated to the
    // receiving path, lives in the fragment.
    assert.match(
      gateFragmentSource,
      /`--yes`[\s\S]*Recommended/,
      'the fragment must resolve to the Recommended branch under --yes',
    );
    assert.match(
      gateFragmentSource,
      /handoff carries `--yes`|carrying `--yes`|carry .*--yes/i,
      'the fragment --yes handoff must propagate --yes to the receiving path',
    );
  });

  it('references the shared scope-triage fragment from both interrogate entries', () => {
    const step1 =
      epicSource.match(/## Step 1 — Interrogate[\s\S]*?(?=\n## Step 2)/)?.[0] ??
      '';
    const fragmentRefs = step1.match(/scope-triage-gate\.md/g) ?? [];
    assert.ok(
      fragmentRefs.length >= 2,
      'both the ideation triage and the story-sized advisory must reference the fragment',
    );
  });

  it('wires --yes auto-proceed at the Story-path draft-confirm HITL stop', () => {
    const hitl =
      storySource.match(
        /### HITL — operator confirms the draft[\s\S]*?(?=\n## Phase 3)/,
      )?.[0] ?? '';
    assert.match(
      hitl,
      /gate #1/i,
      'plan-story draft confirm must be identified as gate #1',
    );
    assert.match(
      hitl,
      /scope-triage-gate\.md/,
      'plan-story gate #1 must reference the shared scope-triage-gate fragment for its --yes resolution',
    );
    assert.match(
      gateFragmentSource,
      /`--yes`[\s\S]*does \*\*not\*\* STOP/i,
      'the fragment must carry the --yes auto-proceed / does-not-STOP note',
    );
  });

  it('plan.md gate #1 covers all three confirm faces (one-pager, draft, clarity)', () => {
    const section = headlessSection();
    assert.match(
      section,
      /existing-Epic[\s\S]*clarity|clarity[\s\S]*existing-Epic/i,
      'gate #1 must enumerate the existing-Epic clarity-refinement confirm face',
    );
    assert.match(
      section,
      /Story path[\s\S]*Story body|drafted Story body/i,
      'gate #1 must enumerate the Story-path draft confirm face',
    );
  });

  it('surfaces a --yes invocation shape in plan-story usage', () => {
    assert.match(
      storySource,
      /\/plan --idea "[^"]*" --yes/,
      'plan-story Invocation shapes must include a --yes example',
    );
  });
});

describe('/plan --yes headless flag — gate #2 (risk-routed pre-persist review)', () => {
  const gate2 =
    epicSource.match(
      /### Gate #2 — risk-routed review[\s\S]*?(?=\n### Run the persist CLI)/,
    )?.[0] ?? '';

  it('anchors gate #2 after authoring and before any GitHub write', () => {
    assert.ok(
      gate2,
      'plan-epic must carry a "Gate #2 — risk-routed review" section before the persist CLI',
    );
    assert.match(
      gate2,
      /before any GitHub write/i,
      'gate #2 must sit before any GitHub write',
    );
  });

  it('shows spec + tickets + risk + deliveryShape in one view', () => {
    assert.match(gate2, /one view/i, 'gate #2 must present one view');
    for (const piece of [/Tech Spec/, /tickets/i, /risk/i, /deliveryShape/]) {
      assert.match(gate2, piece, `gate #2 view must include ${piece}`);
    }
    assert.match(
      gate2,
      /single seam[\s\S]*single-vs-fan-out|vetoes single-vs-fan-out/i,
      'gate #2 must be the single seam to veto single-vs-fan-out routing',
    );
  });

  it('STOPs on high risk / --force-review and auto-proceeds low risk', () => {
    assert.match(
      gate2,
      /\*\*STOP\*\*/,
      'the high-risk branch must be an explicit STOP',
    );
    assert.match(gate2, /--force-review/, 'operator override must be named');
    assert.match(
      gate2,
      /Low risk[\s\S]*continue directly/i,
      'the low-risk branch must auto-proceed to the persist call',
    );
  });

  it('auto-proceeds the review under --yes even when the review is forced', () => {
    assert.match(
      gate2,
      /`--yes`[\s\S]*does\s*\n?>?\s*\*\*not\*\* STOP/i,
      'gate #2 must carry a --yes note stating the review does not STOP',
    );
    assert.match(
      gate2,
      /high-risk or `--force-review`/i,
      'the --yes auto-proceed must apply even when review is forced',
    );
  });

  it('does not alter risk routing or the review criteria themselves', () => {
    assert.match(
      gate2,
      /does \*\*not\*\* alter risk routing or the review\s*\n?>?\s*criteria/i,
      'gate #2 --yes note must state it does not change risk routing or criteria',
    );
  });

  it('treats --yes as a no-op on the low-risk auto-proceed branch (no STOP to suppress)', () => {
    assert.match(
      gate2,
      /`--yes` is a no-op on this branch/i,
      'the low-risk branch must note --yes is a no-op there',
    );
  });
});

describe('/plan --yes headless turn-gap fixes (#4496)', () => {
  const ideation =
    epicSource.match(
      /### Ideation entry[\s\S]*?(?=\n### Existing-Epic entry)/,
    )?.[0] ?? '';
  const step2 =
    epicSource.match(
      /## Step 2 — Author[\s\S]*?(?=\n### Conditional critics)/,
    )?.[0] ?? '';
  const step3 =
    epicSource.match(
      /## Step 3 — Persist[\s\S]*?(?=\n## Troubleshooting)/,
    )?.[0] ?? '';

  it('fix 1 — the headless ideation entry is seed-mode: no idea-refinement activation, no separate one-pager write', () => {
    assert.match(
      ideation,
      /plan-context\.js --seed/,
      'the headless entry must run plan-context.js --seed',
    );
    assert.match(
      ideation,
      /do \*\*not\*\* activate the\s*\n?`idea-refinement` skill/i,
      'the headless entry must not activate idea-refinement',
    );
    assert.match(
      ideation,
      /Attended \(no `--yes`\)/,
      'the attended grill loop must survive (HITL by definition)',
    );
    assert.match(
      ideation,
      /authored \*\*in\s*\nstep 2's single batched write\*\*/,
      'the one-pager must be authored in the batched write',
    );
  });

  it('fix 3 — step 2 mandates parallel Write calls in ONE message', () => {
    assert.match(
      step2,
      /\*\*parallel\s*\n?`Write` calls in ONE message\*\*/,
      'the batched-write mandate must be stated',
    );
    assert.match(step2, /Never write them one-per-turn/);
  });

  it('fix 4 — the envelope systemPrompts are the authoring instructions (no mandated author-skill reads)', () => {
    assert.match(
      step2,
      /`systemPrompts` ARE the authoring instructions/,
      'the envelope-authoritative statement must be present',
    );
    assert.match(
      step2,
      /Do \*\*not\*\* read the/,
      'the author SKILL.md reads must be explicitly retired on this path',
    );
    assert.doesNotMatch(
      step2,
      /activate the\s*\n?\s*\[`epic-plan-spec-author`\]/,
      'no mandated spec-author skill activation may survive',
    );
  });

  it('fix 2 — persist outcomes are authoritative under --yes (no re-derivation)', () => {
    assert.match(
      step3,
      /persist outcomes are authoritative/i,
      'the authoritative-summary rule must be stated',
    );
    assert.match(
      step3,
      /do\s*\n?>?\s*\*\*not\*\* re-derive/i,
      'the no-re-derivation prohibition must be stated',
    );
    assert.match(
      step3,
      /with its reason/i,
      'auto-waivers must be documented as printed with reasons',
    );
  });

  it('fix 5 — the untracked-path auto-normalization is documented at the persist gate list', () => {
    assert.match(step3, /auto-normalizes/i);
    assert.match(step3, /`refactors-existing`[\s\S]*`creates`/);
    assert.match(step3, /Genuine\s*\n?\s*mismatches[\s\S]*still reject/i);
  });

  it('fix 6 — the seed envelope carries the CLI-applied scopeTriage verdict; the fragment forbids the headless skill Read', () => {
    assert.match(ideation, /`scopeTriage`/);
    assert.match(
      gateFragmentSource,
      /applied \*\*CLI-side\*\*/,
      'the fragment must document the CLI-side rubric',
    );
    assert.match(
      gateFragmentSource,
      /Do \*\*not\*\* Read the\s*\n?`core\/scope-triage` skill headless/,
      'the fragment must forbid the headless skill Read',
    );
    assert.match(
      planSource,
      /Under `--yes`, do not\s*\n?\s*Read the skill/i,
      'the router must skip the triage skill Read under --yes',
    );
  });

  it('fix 7 — the router executes injected helper content without a read-in-full turn under --yes', () => {
    assert.match(
      planSource,
      /already injected or present in context, execute it\s*\n?\s*directly/i,
      'the read-in-full exemption must be stated',
    );
    assert.match(
      planSource,
      /do not spend a separate read-in-full turn/i,
      'the exemption must name the read-in-full turn',
    );
  });

  it('gate restatement — the G2 reference states the per-mode turn/token gates', () => {
    const reference = readFileSync(
      path.join(WORKFLOWS, 'helpers', 'plan-epic-reference.md'),
      'utf8',
    );
    assert.match(reference, /Epic-mode[\s\S]*≤ ~12 turns \/ ≤ ~1\.1M/);
    assert.match(reference, /Ideation-mode[\s\S]*≤ ~15 turns \/ ≤ ~1\.5M/m);
    assert.match(
      reference,
      /interim smoke\s*\n?\s*threshold ≤ ~20 turns \/ ≤ ~2\.0M/i,
    );
  });
});
