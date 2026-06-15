/**
 * tests/deliver-integration-gate.test.js
 *
 * Epic #4131 (F1/F4 / AC-1, AC-5) — the post-wave integration gate and the
 * `@pending`-is-not-green close rule for surface-adding Epics.
 *
 * This spec is a structural assertion over the authored `deliver-epic.md`
 * workflow source — it does not execute the workflow (that is the host LLM's
 * job); it pins the load-bearing contract the Story documents:
 *
 *   1. POST-WAVE GATE POSITION (AC-1) — `deliver-epic.md` documents a new
 *      integration-gate phase positioned AFTER the wave loop (`epic-complete`)
 *      and BEFORE finalize (Phase 7), whose evidence spans the WHOLE PRODUCT,
 *      not the change set.
 *   2. @PENDING ≠ GREEN (AC-5) — a surface-adding Epic whose acceptance
 *      coverage is only `@pending` FAILS the close gate instead of passing
 *      green; refactor/docs Epics are unaffected.
 *   3. NO-OP WHEN UNCONFIGURED + OVERRIDE — the gate is documented as a silent
 *      no-op when no journey suite / nav config is present, with an explicit
 *      operator override (`--skip-integration-gate`) consistent with
 *      `--skip-epic-audit`.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

const WORKFLOW_PATH = path.join(
  REPO_ROOT,
  '.agents',
  'workflows',
  'helpers',
  'deliver-epic.md',
);

const source = readFileSync(WORKFLOW_PATH, 'utf8');

/** Byte offset of a heading anchor, or -1 when absent. */
function headingOffset(pattern) {
  return source.search(pattern);
}

describe('deliver-epic post-wave integration gate (Epic #4131 F1/F4)', () => {
  // --- AC-1: a new post-wave integration-gate phase ------------------------

  it('documents a post-wave integration-gate phase as its own section', () => {
    assert.match(
      source,
      /##\s+Phase 6\.5 — Post-wave integration gate/,
      'deliver-epic.md must define a Phase 6.5 post-wave integration-gate section',
    );
  });

  it('positions the gate AFTER the ready-set loop (epic-complete) and BEFORE finalize', () => {
    const waveLoop = headingOffset(/##\s+Phase 2 — Ready-set loop/);
    const gate = headingOffset(/##\s+Phase 6\.5 — Post-wave integration gate/);
    const finalize = headingOffset(/##\s+Phase 7 — Finalize/);

    assert.ok(waveLoop !== -1, 'Phase 2 ready-set loop section is missing');
    assert.ok(gate !== -1, 'Phase 6.5 integration-gate section is missing');
    assert.ok(finalize !== -1, 'Phase 7 finalize section is missing');

    // Ordering: wave loop < integration gate < finalize.
    assert.ok(
      waveLoop < gate,
      'the integration gate must be documented after the wave loop',
    );
    assert.ok(
      gate < finalize,
      'the integration gate must be documented before finalize',
    );
  });

  it('ties the gate to the wave loop reporting epic-complete', () => {
    const section = integrationGateSection();
    assert.match(
      section,
      /epic-complete/,
      'the gate section must reference the wave loop reporting epic-complete',
    );
    assert.match(
      section,
      /before[\s\S]*?finalize/i,
      'the gate section must state it runs before finalize',
    );
  });

  it('documents the gate evidence as whole-product, not the change set', () => {
    const section = integrationGateSection();
    assert.match(
      section,
      /whole product|whole-route|whole route/i,
      'the gate must document whole-product evidence',
    );
    assert.match(
      section,
      /not (just )?the change set|deliberately-global/i,
      'the gate must contrast its scope against the change-set-scoped gates',
    );
  });

  it('runs the navigability lens plus the consumer journey suite', () => {
    const section = integrationGateSection();
    assert.match(
      section,
      /navigability/i,
      'the gate must run the navigability lens',
    );
    assert.match(
      section,
      /journey suite|journeySuite/,
      'the gate must run the consumer journey suite',
    );
  });

  it('blocks finalize on an orphaned surface and names it', () => {
    const section = integrationGateSection();
    assert.match(
      section,
      /orphan/i,
      'the gate must name the orphaned-surface failure mode',
    );
    assert.match(
      section,
      /block(s)? finalize/i,
      'the gate must block finalize on a hard failure',
    );
  });

  // --- AC-5: @pending is not green for surface-adding Epics ----------------

  it('documents that a surface-adding Epic with only @pending coverage fails the close gate', () => {
    const section = integrationGateSection();
    assert.match(
      section,
      /@pending/,
      'the gate must reference @pending acceptance scenarios',
    );
    assert.match(
      section,
      /surface-adding/i,
      'the @pending rule must be scoped to surface-adding Epics',
    );
    assert.match(
      section,
      /fails the close gate|fail(s)? the close gate/i,
      'a @pending-only surface-adding Epic must fail the close gate',
    );
  });

  it('leaves refactor/docs Epics unaffected (not de-scoped)', () => {
    const section = integrationGateSection();
    assert.match(
      section,
      /refactor[\s-]*only|refactor.*docs.*Epics.*unaffected|unaffected/i,
      'the @pending rule must leave non-surface-adding Epics unaffected',
    );
    assert.match(
      section,
      /not\s+de-scoped|purely additive/i,
      'the existing acceptance reconciliation must not be de-scoped',
    );
  });

  // --- No-op when unconfigured + explicit operator override -----------------

  it('documents the gate as a silent no-op when no nav config / journey suite is present', () => {
    const section = integrationGateSection();
    assert.match(
      section,
      /silent no-op/i,
      'the gate must be a silent no-op when unconfigured',
    );
    assert.match(
      section,
      /unconfigured/i,
      'the no-op must be tied to the unconfigured-consumer case',
    );
  });

  it('documents an explicit operator override consistent with --skip-epic-audit', () => {
    // The flag appears in the Arguments list...
    assert.match(
      source,
      /--skip-integration-gate/,
      'an explicit --skip-integration-gate override must be documented',
    );
    // ...and is explicitly framed as consistent with --skip-epic-audit.
    const argsBlock = source.slice(headingOffset(/--skip-integration-gate/));
    assert.match(
      argsBlock,
      /consistent with[\s\S]*?--skip-epic-audit/,
      'the override must be framed as consistent with --skip-epic-audit',
    );
  });

  it('lists the gate in the overview phase diagram between Phase 6 and Phase 7', () => {
    assert.match(
      source,
      /Phase 6\.5 — integration gate/,
      'the overview phase diagram must list the Phase 6.5 integration gate',
    );
  });
});

/**
 * Slice the authored Phase 6.5 section out of the source so the assertions
 * above bind to the gate's own prose rather than incidental matches
 * elsewhere in the workflow.
 */
function integrationGateSection() {
  const start = source.search(/##\s+Phase 6\.5 — Post-wave integration gate/);
  assert.ok(start !== -1, 'Phase 6.5 section not found');
  const rest = source.slice(start);
  const end = rest.search(/\n##\s+Phase 7 — Finalize/);
  assert.ok(end !== -1, 'Phase 7 boundary not found after Phase 6.5');
  return rest.slice(0, end);
}
