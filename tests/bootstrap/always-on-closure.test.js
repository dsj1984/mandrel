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
 * The AC-4 workflow-spine budgets live in the sibling
 * `workflow-spine-budget.test.js`.
 */

import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

/** AC-1: instructions + always-on rules must fit under 16KB. */
const CLOSURE_BUDGET_BYTES = 16 * 1024;

/**
 * Extract the `.agents/` @-import targets from CLAUDE.md — the instruction
 * spine plus every always-on rule. Measuring what CLAUDE.md actually imports
 * (rather than a hardcoded list) means promoting a new rule into the
 * always-on core is automatically charged against the budget.
 */
function alwaysOnClosureFiles() {
  const claudeMd = readFileSync(path.join(REPO_ROOT, 'CLAUDE.md'), 'utf8');
  const files = [];
  for (const line of claudeMd.split('\n')) {
    const m = line.match(/^@(\.agents\/\S+\.md)\s*$/);
    if (m) files.push(m[1]);
  }
  return files;
}

describe('always-on closure budget (Story #4708, AC-1)', () => {
  it('CLAUDE.md imports the instruction spine and the always-on rules', () => {
    const files = alwaysOnClosureFiles();
    assert.ok(
      files.includes('.agents/instructions.md'),
      'CLAUDE.md must @-import .agents/instructions.md',
    );
    assert.ok(
      files.includes('.agents/rules/security-baseline.md'),
      'CLAUDE.md must @-import the security baseline — it is always-on by contract (AC-2)',
    );
    assert.ok(
      files.includes('.agents/rules/git-conventions.md'),
      'CLAUDE.md must @-import the always-on git core',
    );
  });

  it(`instructions + always-on rules total ≤ ${CLOSURE_BUDGET_BYTES} bytes`, () => {
    const files = alwaysOnClosureFiles();
    const sized = files.map((f) => ({
      file: f,
      bytes: statSync(path.join(REPO_ROOT, f)).size,
    }));
    const total = sized.reduce((sum, s) => sum + s.bytes, 0);
    assert.ok(
      total <= CLOSURE_BUDGET_BYTES,
      `always-on closure is ${total} bytes, over the ${CLOSURE_BUDGET_BYTES}-byte budget ` +
        `(${sized.map((s) => `${s.file}=${s.bytes}`).join(', ')}). ` +
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
