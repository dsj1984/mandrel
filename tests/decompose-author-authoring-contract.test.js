/**
 * Story authoring contract (Epic #4131 / Story #4137, F5 + F8).
 *
 * Pins the binding/advisory altitude contract and the navigate-don't-deep-link
 * acceptance standard authored into the planning + execution surface:
 *
 *   - `.agents/skills/core/epic-plan-decompose-author/SKILL.md` states that
 *     `acceptance[]` / `verify[]` are the binding contract and
 *     `changes[]` / `references[]` are an advisory sketch the executor may
 *     revise (AC-9), and documents the navigate-don't-deep-link standard for
 *     signed-in acceptance scenarios (AC-6).
 *   - `.agents/personas/engineer.md` grants the executor explicit latitude to
 *     deviate from the suggested approach when the rationale is logged, and
 *     states the latitude never overrides `acceptance[]` / `verify[]` or the
 *     security baseline (AC-9 / AC-14).
 *
 * This is a structural assertion over the authored documentation source — it
 * does not execute the planning flow. It also guards the additive-only
 * invariant: the pre-existing file-assumption / New-File-Contract gate language
 * in the SKILL must survive untouched alongside the new advisory framing.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

const SKILL_PATH = path.join(
  REPO_ROOT,
  '.agents',
  'skills',
  'core',
  'epic-plan-decompose-author',
  'SKILL.md',
);

const ENGINEER_PATH = path.join(
  REPO_ROOT,
  '.agents',
  'personas',
  'engineer.md',
);

const skill = readFileSync(SKILL_PATH, 'utf8');
const engineer = readFileSync(ENGINEER_PATH, 'utf8');

describe('epic-plan-decompose-author authoring-contract altitude (F8)', () => {
  it('names acceptance[]/verify[] as the binding contract', () => {
    assert.match(
      skill,
      /`acceptance\[\]`\s+and\s+`verify\[\]`\s+are\s+the\s+Story's\s+\*\*binding contract\*\*/,
      'SKILL must declare acceptance[]/verify[] the binding contract',
    );
  });

  it('names changes[]/references[] as an advisory sketch the executor may revise', () => {
    assert.match(
      skill,
      /`changes\[\]`\s+and\s+`references\[\]`\s+are\s+an\s+\*\*advisory implementation sketch\*\*/,
      'SKILL must declare changes[]/references[] an advisory sketch',
    );
    assert.match(
      skill,
      /executor\s+MAY\s+revise/i,
      'SKILL must state the executor may revise the advisory sketch',
    );
  });

  it('preserves the file-assumption gate (additive framing — no de-scope)', () => {
    // The existing structural gate language MUST survive the additive change.
    assert.match(
      skill,
      /New-File Contract/,
      'New-File Contract language must remain',
    );
    assert.match(
      skill,
      /`creates`\s+against\s+an\s+existing\s+path/,
      'the creates-against-existing structural probe language must remain',
    );
    assert.match(
      skill,
      /file-assumption gate/i,
      'SKILL must still reference the file-assumption gate as un-weakened',
    );
  });

  it('keeps the advisory sketch bound by acceptance/verify and the security baseline', () => {
    assert.match(
      skill,
      /security-baseline\.md/,
      'SKILL must bound the latitude by rules/security-baseline.md',
    );
  });
});

describe("epic-plan-decompose-author navigate-don't-deep-link standard (F5)", () => {
  it("documents the navigate-don't-deep-link acceptance standard", () => {
    assert.match(
      skill,
      /navigate-don't-deep-link/i,
      "SKILL must name the navigate-don't-deep-link standard",
    );
  });

  it('requires signed-in scenarios to reach the feature through navigation', () => {
    assert.match(
      skill,
      /signed-in/i,
      'SKILL must scope the standard to signed-in scenarios',
    );
    assert.match(
      skill,
      /through navigation/i,
      'SKILL must require reaching the feature through navigation',
    );
  });

  it('forbids reaching the feature via a hardcoded deep-link URL', () => {
    assert.match(
      skill,
      /never[^.]*hardcoded deep-link/i,
      'SKILL must forbid the hardcoded deep-link URL form',
    );
  });
});

describe('engineer persona executor latitude (F8 / AC-14)', () => {
  it('grants explicit latitude to deviate from the suggested approach', () => {
    assert.match(
      engineer,
      /Implementation Latitude/,
      'engineer.md must carry an Implementation Latitude section',
    );
    assert.match(
      engineer,
      /MAY\s+deviate\s+from\s+the\s+suggested\s+approach/,
      'engineer.md must grant latitude to deviate from the suggested approach',
    );
  });

  it('requires the deviation rationale to be logged', () => {
    assert.match(
      engineer,
      /record\s+the\s+rationale/i,
      'engineer.md must require recording the deviation rationale',
    );
  });

  it('treats changes[]/references[] as advisory and acceptance[]/verify[] as binding', () => {
    assert.match(
      engineer,
      /advisory implementation\s+sketch/i,
      'engineer.md must call changes[]/references[] an advisory sketch',
    );
    assert.match(
      engineer,
      /binding\s+contract/i,
      'engineer.md must call acceptance[]/verify[] the binding contract',
    );
  });

  it('states the latitude never overrides acceptance/verify or the security baseline', () => {
    assert.match(
      engineer,
      /does\s+\*\*not\*\*\s+license\s+deviating\s+from\s+`acceptance\[\]`\s+\/\s+`verify\[\]`/,
      'engineer.md must say latitude does not override acceptance[]/verify[]',
    );
    assert.match(
      engineer,
      /security-baseline\.md/,
      'engineer.md must bound the latitude by the security baseline',
    );
  });
});
