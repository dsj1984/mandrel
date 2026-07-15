/**
 * `/plan --yes` headless / non-interactive flag contract after the v2 Stage 3
 * planning-fork cutover.
 *
 * `/plan` is workflow prose interpreted by the host LLM, so this spec is a
 * structural assertion over the single authored workflow source. It pins the
 * useful `--yes` semantics that survived the fork removal:
 *
 *   - `/plan` is one 3-step path, not an Epic/Story router.
 *   - `--yes` auto-proceeds gate #1 (interrogate confirmation).
 *   - `--yes` auto-proceeds gate #2 (risk-routed pre-persist review).
 *   - `--yes` does not relax deterministic validation gates.
 *   - the retired `deliveryShape` and scope-triage routing fields do not
 *     reappear in the workflow contract.
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

function section(headingPattern) {
  return (
    planSource.match(
      new RegExp(`${headingPattern}[\\s\\S]*?(?=\\n#{2,3} )`),
    )?.[0] ?? ''
  );
}

describe('/plan --yes headless flag — single plan.md path', () => {
  it('documents --yes in the flag table as a headless HITL auto-proceed flag', () => {
    const flagRow = planSource
      .split('\n')
      .find((line) => /^\|\s*`--yes`\s*\|/.test(line));
    assert.ok(flagRow, 'plan.md flag table must carry a `--yes` row');
    assert.match(
      flagRow,
      /Non-interactive: auto-proceed gate #1 and gate #2 HITL waits/i,
      '`--yes` row must name both HITL gates it auto-proceeds',
    );
  });

  it('states that /plan is a single path and no longer routes by scope verdict', () => {
    assert.match(
      planSource,
      /Single planning path/i,
      'plan.md must declare a single planning path',
    );
    assert.match(
      planSource,
      /there is no\s*\n?Epic\/Story router/i,
      'plan.md must reject the retired Epic/Story router',
    );
    assert.match(
      planSource,
      /no scope-triage `epic\|story` verdict/i,
      'plan.md must reject scope-triage routing verdicts',
    );
  });

  it('defines the three-step Interrogate -> Author -> Persist ceremony', () => {
    assert.match(planSource, /### 1\. Interrogate/);
    assert.match(planSource, /### 2\. Author/);
    assert.match(planSource, /### 3\. Persist/);
  });
});

describe('/plan --yes headless flag — gate #1', () => {
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
    assert.match(
      interrogate,
      /duplicate-candidate review/i,
      'gate #1 must include duplicate-candidate review',
    );
  });

  it('auto-proceeds under --yes without free-form operator questions', () => {
    assert.match(
      interrogate,
      /Under `--yes`, auto-proceed/i,
      'gate #1 must auto-proceed under --yes',
    );
    assert.match(
      interrogate,
      /do not ask free-form operator questions/i,
      'headless interrogation must not ask operator questions',
    );
    assert.match(
      interrogate,
      /Key Assumptions/,
      'unresolved unknowns must land in the one-pager Key Assumptions section',
    );
  });
});

describe('/plan --yes headless flag — gate #2', () => {
  const persist = section('### 3\\. Persist');

  it('anchors gate #2 at the risk-routed pre-persist review', () => {
    assert.ok(persist, 'plan.md must carry the persist step');
    assert.match(
      persist,
      /\*\*Gate #2\*\*[\s\S]*risk routing requires review/i,
      'gate #2 must be risk-routed',
    );
    assert.match(
      persist,
      /`--force-review`/,
      'gate #2 must still honor --force-review',
    );
    assert.match(
      persist,
      /before\s*\n?persist/i,
      'gate #2 must happen before persist',
    );
  });

  it('auto-proceeds gate #2 under --yes', () => {
    assert.match(
      persist,
      /Under `--yes`, auto-proceed/i,
      'gate #2 must auto-proceed under --yes',
    );
  });
});

describe('/plan --yes headless flag — v2 Stage 3 cutover guards', () => {
  it('keeps --yes scoped to HITL waits; deterministic gates still fail closed', () => {
    assert.match(
      planSource,
      /Deterministic gates[\s\S]*still fail closed under `--yes`/i,
      'plan.md must state --yes is not a validation override',
    );
  });

  it('uses the story author prompt and default-single policy instead of deliveryShape routing', () => {
    const author = section('### 2\\. Author');
    assert.ok(author, 'plan.md must carry the author step');
    assert.match(
      author,
      /`stories\.json`[\s\S]*\*\*length 1 by default\*\*/i,
      'authoring must default to one Story',
    );
    assert.match(
      author,
      /Use the envelope `systemPrompts\.story`/i,
      'authoring must consume the story prompt from the envelope',
    );
    assert.match(
      author,
      /Split only under the\s*\n?policy above/i,
      'splitting must be controlled by the default-single policy',
    );
  });

  it('keeps risk verdicts free of deliveryShape fields', () => {
    const author = section('### 2\\. Author');
    assert.match(
      author,
      /`risk-verdict\.json`[\s\S]*\*\*no `deliveryShape`\*\*/i,
      'risk-verdict artifact must explicitly exclude deliveryShape',
    );
  });

  it('does not link to the deleted planning helpers', () => {
    for (const deleted of [
      'helpers/plan-epic.md',
      'helpers/plan-story.md',
      'helpers/scope-triage-gate.md',
      'helpers/plan-epic-reference.md',
    ]) {
      assert.doesNotMatch(planSource, new RegExp(deleted.replace('.', '\\.')));
    }
  });

  it('keeps scope-triage as optional split-advisory notes only', () => {
    assert.match(
      planSource,
      /optional\s*\n?\s*split-advisory notes only \(no routing verdict\)/i,
      'scope-triage skill link must be advisory-only',
    );
  });
});
