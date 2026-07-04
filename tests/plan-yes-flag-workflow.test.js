/**
 * `/plan --yes` headless / non-interactive flag contract (Story #4223).
 *
 * Story #4223 adds a `--yes` non-interactive flag to `/plan` — the planning
 * parallel of `/deliver --yes` — that deterministically auto-proceeds the two
 * `/plan` HITL STOP gates without waiting for operator input:
 *
 *   - **Gate #1** — the ideation one-pager / scope-triage confirm (on the
 *     `--idea` path, in both the Epic and Story path helpers).
 *   - **Gate #2** — the Phase-7 Epic operator review gate (when risk routing
 *     forces it).
 *
 * `/plan` is workflow PROSE interpreted by the host LLM — there is no Node CLI
 * arg parser for it (the router owns argument parsing in prose; the path
 * helpers own the gates). So this spec is a STRUCTURAL assertion over the
 * authored workflow sources — it does not execute the workflow (that is the
 * host LLM's job), it pins the load-bearing contract that the flag is:
 *
 *   1. documented in the `plan.md` flag table and surfaced in `/plan` usage,
 *   2. wired at gate #1 (one-pager / draft confirm) in both path helpers,
 *   3. wired at gate #2 (Phase-7 review) in the Epic path helper,
 *   4. composed with `--allow-over-budget` and the risk-routed Phase-7 skip,
 *   5. scoped to the HITL waits only (it does not relax deterministic gates),
 *   6. and leaves default (no-flag) behavior unchanged (the STOPs remain).
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
// shared fragment. plan-epic Phase 1.5 / 5.5 and plan-story Phase 2 REFERENCE
// it and keep only their path-specific firing conditions, so the shared --yes
// contract is asserted against the fragment while each path is asserted to
// reference it and to name its own Recommended branch.
const gateFragmentSource = readFileSync(
  path.join(WORKFLOWS, 'helpers', 'scope-triage-gate.md'),
  'utf8',
);

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
    const section =
      planSource.match(
        /###\s+Headless \/ non-interactive mode[\s\S]*?(?=\n## )/,
      )?.[0] ?? '';
    assert.match(
      section,
      /gate #1/i,
      'headless section must name gate #1 (ideation one-pager / scope-triage)',
    );
    assert.match(
      section,
      /gate #2/i,
      'headless section must name gate #2 (Phase-7 review)',
    );
    assert.match(
      section,
      /one-pager|scope-triage/i,
      'gate #1 must be described as the ideation one-pager / scope-triage confirm',
    );
    assert.match(
      section,
      /Phase[- ]?7/i,
      'gate #2 must be described as the Phase-7 operator review gate',
    );
  });

  it('documents composition with --allow-over-budget and the risk-routed Phase-7 skip', () => {
    const section =
      planSource.match(
        /###\s+Headless \/ non-interactive mode[\s\S]*?(?=\n## )/,
      )?.[0] ?? '';
    assert.match(
      section,
      /--allow-over-budget/,
      'headless section must document composition with --allow-over-budget',
    );
    assert.match(
      section,
      /risk-routed Phase-7 skip/i,
      'headless section must document composition with the risk-routed Phase-7 skip',
    );
  });

  it('scopes --yes to the HITL waits only (deterministic gates still run)', () => {
    const section =
      planSource.match(
        /###\s+Headless \/ non-interactive mode[\s\S]*?(?=\n## )/,
      )?.[0] ?? '';
    // The flag must NOT be a validation override — deterministic gates and the
    // agent::blocked runtime pause are unaffected.
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

describe('/plan --yes headless flag — gate #1 (one-pager / draft confirm)', () => {
  it('wires --yes auto-proceed at the Epic-path Phase 1 HITL stop', () => {
    // The Phase 1 confirm must be tagged as gate #1 and carry a --yes
    // auto-proceed note.
    assert.match(
      epicSource,
      /HITL stop — confirm the sharpened one-pager\*\*\s*\(\*\*gate #1\*\*\)/,
      'plan-epic Phase 1 confirm must be labeled gate #1',
    );
    const phase1 =
      epicSource.match(
        /confirm the sharpened one-pager[\s\S]*?(?=\n## Phase 1\.5)/,
      )?.[0] ?? '';
    assert.match(
      phase1,
      /`--yes`[^\n]*auto-proceed/i,
      'plan-epic gate #1 must carry a --yes auto-proceed note',
    );
    assert.match(
      phase1,
      /does \*\*not\*\* STOP/i,
      'plan-epic gate #1 --yes note must state the gate does not STOP',
    );
  });

  it('resolves a story/borderline verdict to the Recommended branch under --yes', () => {
    // The shared --yes → Recommended resolution (and the --yes handoff
    // propagation) is single-homed in the scope-triage-gate fragment
    // (Story #4341); Phase 1.5 references the fragment and names its own
    // Recommended handoff branch.
    const phase15 =
      epicSource.match(
        /## Phase 1\.5: Scope Triage[\s\S]*?(?=\n## Phase 2)/,
      )?.[0] ?? '';
    assert.match(
      phase15,
      /scope-triage-gate\.md/,
      'Phase 1.5 must reference the shared scope-triage-gate fragment',
    );
    assert.match(
      phase15,
      /Recommended branch[\s\S]*story[\s\S]*borderline|story[\s\S]*borderline[\s\S]*Recommended/i,
      'Phase 1.5 must name its Recommended branch on a story/borderline verdict',
    );
    assert.match(
      phase15,
      /scope-triage handoff so `\/plan` skips its\s+own gate/,
      'Phase 1.5 Recommended branch must hand off as a scope-triage handoff',
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
    // Story #4341 single-homed the --yes resolution in the scope-triage-gate
    // fragment; the plan-story HITL stop references it rather than restating
    // the auto-proceed / no-STOP prose.
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

  it('wires --yes auto-proceed at the existing-Epic Phase 6 clarity refinement-diff confirm', () => {
    // criterion 2's `/plan <epicId> --yes` path: the Phase 6 needs-refinement
    // diff confirm is an operator wait that --yes must auto-proceed, else an
    // AC-less / unclear Epic body still blocks the headless run.
    const phase6 =
      epicSource.match(
        /## Phase 6: Epic Clarity Gate[\s\S]*?(?=\n## Phase 7:)/,
      )?.[0] ?? '';
    assert.match(
      phase6,
      /`--yes`[\s\S]*does \*\*not\*\* STOP/i,
      'Phase 6 refinement-diff confirm must carry a --yes auto-proceed note',
    );
    assert.match(
      phase6,
      /existing-Epic[\s\S]*gate #1|gate #1[\s\S]*existing-Epic/i,
      'Phase 6 confirm must be tied to gate #1 on the existing-Epic path',
    );
  });

  it('plan.md gate #1 covers all three confirm faces (one-pager, draft, clarity diff)', () => {
    const section =
      planSource.match(
        /###\s+Headless \/ non-interactive mode[\s\S]*?(?=\n## )/,
      )?.[0] ?? '';
    assert.match(
      section,
      /existing-Epic[\s\S]*Clarity Gate|Clarity Gate[\s\S]*existing-Epic/i,
      'gate #1 must enumerate the existing-Epic clarity confirm face',
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

describe('/plan --yes headless flag — gate #2 (Phase-7 review)', () => {
  const reviewRouting =
    epicSource.match(
      /4\. \*\*Verification and review routing\*\*:[\s\S]*?(?=\n5\. \*\*Tech Spec freshness)/,
    )?.[0] ?? '';

  it('labels the high-risk review STOP as gate #2', () => {
    assert.ok(reviewRouting, 'Phase 7 review-routing step must be present');
    assert.match(
      reviewRouting,
      /gate #2/i,
      'the high-risk review STOP must be labeled gate #2',
    );
  });

  it('auto-proceeds the review under --yes even when requiresReview is true', () => {
    assert.match(
      reviewRouting,
      /`--yes`[\s\S]*does \*\*not\*\* STOP/i,
      'gate #2 must carry a --yes note stating the review does not STOP',
    );
    assert.match(
      reviewRouting,
      /requiresReview === true|--force-review/,
      'the --yes auto-proceed must apply even when review is forced',
    );
    assert.match(
      reviewRouting,
      /continues? directly to\s*\n?\s*>?\s*\*?\*?Phase 8/i,
      'under --yes the run must continue directly to Phase 8',
    );
  });

  it('does not alter risk routing or the review criteria themselves', () => {
    assert.match(
      reviewRouting,
      /does\s*\n?\s*>?\s*\*\*not\*\* alter risk routing or the review criteria/i,
      'gate #2 --yes note must state it does not change risk routing or criteria',
    );
  });

  it('treats --yes as a no-op on the low-risk auto-proceed branch (no STOP to suppress)', () => {
    assert.match(
      reviewRouting,
      /`--yes` is\s*\n?\s*a no-op on this branch/i,
      'the low-risk branch must note --yes is a no-op there',
    );
  });
});
