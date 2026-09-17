/**
 * tests/bootstrap/always-on-closure.test.js — the always-on residency budget
 * (Story #4708, AC-1 / AC-2 / AC-4).
 *
 * The `CLAUDE.md` @-closure (instructions.md + the always-on rules) is
 * re-paid on every session and every subagent spawn, so its byte total is a
 * per-turn tax. Story #4708 dieted it from ~25.7KB to under 16KB; this test
 * is the ratchet that keeps it there — growth above the budget fails and
 * must be paid for by an equivalent trim, not absorbed silently.
 *
 * AC-2 companion: the diet must never thin the security baseline. The
 * baseline file stays @-imported (resident) and every MUST section survives.
 *
 * The AC-4 workflow-spine budgets used to live in a sibling file. Story #5340
 * deleted them: the per-file 8 KB ceiling and its minimum-headroom floor made
 * every prose fix buy its bytes from an unrelated trim. This closure budget is
 * the one that stays, because it is the only tier every session and every
 * subagent spawn re-pays unconditionally.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { resolveAlwaysLoadedClosure } from '../../.agents/scripts/lib/doc-tiers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

/**
 * AC-1: the whole always-loaded closure must fit under this ceiling.
 *
 * Story #4821 widened what this charges. The previous regex matched only
 * `@.agents/**.md`, so `AGENTS.md` and `.agentrc.json` — both @-imported by
 * CLAUDE.md and both re-paid on every spawn — were invisible to the ratchet
 * and could grow for free. The ceiling rose to cover them; it is NOT slack
 * for the files that were already charged.
 */
const CLOSURE_BUDGET_BYTES = 21 * 1024;

/**
 * The always-loaded closure, resolved by the same function the CI
 * context-budget gate uses (`check-context-budget.js` →
 * `resolveAlwaysLoadedClosure`). Sharing the resolver is the point: two
 * private definitions of "always loaded" drifted ~5KB apart before #4821,
 * and a ratchet that disagrees with the gate it backstops reports a number
 * nobody can act on. Every `@`-import of CLAUDE.md is charged transitively —
 * promoting a rule into the always-on core is billed automatically.
 */
function alwaysOnClosureEntries() {
  return resolveAlwaysLoadedClosure(REPO_ROOT);
}

describe('always-on closure budget (Story #4708, AC-1; widened by #4821)', () => {
  it('charges every CLAUDE.md @-import, not just the .agents/ ones', () => {
    const files = alwaysOnClosureEntries().map((e) => e.path);
    for (const required of [
      'CLAUDE.md',
      '.agents/instructions.md',
      '.agents/rules/security-baseline.md',
      '.agents/rules/git-conventions.md',
      'AGENTS.md',
      '.agentrc.json',
    ]) {
      assert.ok(
        files.includes(required),
        `${required} is @-imported by CLAUDE.md but is not charged against the closure budget — ` +
          'it would be re-paid every spawn while growing for free',
      );
    }
  });

  it('keeps the security baseline resident', () => {
    const files = alwaysOnClosureEntries().map((e) => e.path);
    assert.ok(
      files.includes('.agents/rules/security-baseline.md'),
      'CLAUDE.md must @-import the security baseline — it is always-on by contract (AC-2)',
    );
  });

  it(`the always-loaded closure totals ≤ ${CLOSURE_BUDGET_BYTES} bytes`, () => {
    const sized = alwaysOnClosureEntries();
    const total = sized.reduce((sum, s) => sum + s.bytes, 0);
    assert.ok(
      total <= CLOSURE_BUDGET_BYTES,
      `always-on closure is ${total} bytes, over the ${CLOSURE_BUDGET_BYTES}-byte budget ` +
        `(${sized.map((s) => `${s.path}=${s.bytes}`).join(', ')}). ` +
        'This tax is re-paid every session and every subagent spawn — pay for the growth with an equivalent trim.',
    );
  });
});

describe('security-baseline MUST retention (Story #4708, AC-2)', () => {
  const baseline = readFileSync(
    path.join(REPO_ROOT, '.agents', 'rules', 'security-baseline.md'),
    'utf8',
  );

  it('every security MUST section is still resident', () => {
    for (const section of [
      '## Input Validation',
      '## Authentication',
      '## Authorization',
      '## Output & Rendering',
      '## Data Leakage & Logging',
      '## Transport & Headers',
      '## Secrets Management',
      '## Dependency Hygiene',
      '## Forbidden Practices',
    ]) {
      assert.ok(
        baseline.includes(section),
        `security-baseline.md lost its "${section}" section — no diet may thin the baseline`,
      );
    }
  });

  it('the MUST density has not been eroded', () => {
    const musts = baseline.match(/MUST/g) ?? [];
    assert.ok(
      musts.length >= 25,
      `security-baseline.md carries only ${musts.length} MUST statements (expected ≥ 25) — the baseline may have been thinned`,
    );
  });

  it('sentinel MUSTs survive verbatim', () => {
    for (const sentinel of [
      'Passwords MUST be hashed',
      'Database queries MUST be parameterized',
      'pulled from environment variables',
      'NEVER log Personal Identifiable Information',
    ]) {
      assert.ok(
        baseline.includes(sentinel),
        `security-baseline.md lost the sentinel MUST: "${sentinel}"`,
      );
    }
  });
});
