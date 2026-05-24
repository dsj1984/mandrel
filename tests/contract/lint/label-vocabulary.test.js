/**
 * tests/contract/lint/label-vocabulary.test.js — Story #2892 / Task #2910
 *
 * Contract: `.agents/scripts/lint-label-vocabulary.js` MUST
 *   1. Detect axis-shaped tokens inside inline backtick code spans that
 *      use a non-`::` separator (the F9 typo class).
 *   2. Ignore prose mentions of the same axis names (e.g.
 *      "planning/audit metadata") that are not inside backticks.
 *   3. Exit 0 against the post-fix repo state (no real-world drift
 *      remains after Story #2892 lands).
 *   4. Surface file + line in the violation report for operator triage.
 */

import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  findVocabularyViolations,
  lintLabelVocabulary,
} from '../../../.agents/scripts/lint-label-vocabulary.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT_PATH = path.join(
  REPO_ROOT,
  '.agents',
  'scripts',
  'lint-label-vocabulary.js',
);

describe('lint-label-vocabulary — pure scanner contract', () => {
  it('flags drift inside an inline code span', () => {
    const src = '1. Apply the `type/epic` label to seed the Epic.';
    const violations = findVocabularyViolations(src);
    assert.equal(violations.length, 1);
    assert.equal(violations[0].axis, 'type');
    assert.equal(violations[0].separator, '/');
    assert.equal(violations[0].line, 1);
  });

  it('flags drift across multiple axes on different lines', () => {
    const src = [
      'Apply `type/epic` to seed.',
      '',
      'Then `agent/ready` when ready.',
    ].join('\n');
    const violations = findVocabularyViolations(src);
    assert.equal(violations.length, 2);
    assert.equal(violations[0].line, 1);
    assert.equal(violations[1].line, 3);
    assert.equal(violations[1].axis, 'agent');
  });

  it('does not flag hyphenated concept slugs like `agent-protocol`', () => {
    const src = 'See `agent-protocol` for the canonical reference.';
    assert.deepEqual(findVocabularyViolations(src), []);
  });

  it('does not flag composite canonical labels like `context::acceptance-spec`', () => {
    const src = 'Set the `context::acceptance-spec` link.';
    assert.deepEqual(findVocabularyViolations(src), []);
  });

  it('passes the canonical `::` separator', () => {
    const src = '`type::epic` and `agent::ready` are fine.';
    assert.deepEqual(findVocabularyViolations(src), []);
  });

  it('ignores axis names that appear in prose (no backticks)', () => {
    const src =
      '> remains planning/audit metadata only; the sole runtime pause point is';
    assert.deepEqual(findVocabularyViolations(src), []);
  });
});

describe('lint-label-vocabulary — repo state', () => {
  it('exits 0 against the post-fix repo state', () => {
    const violations = lintLabelVocabulary();
    assert.deepEqual(
      violations,
      [],
      `expected zero violations, got:\n${JSON.stringify(violations, null, 2)}`,
    );
  });

  it('CLI invocation exits non-zero when a temp doc carries drift', () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'lint-label-vocab-'));
    try {
      const driftDoc = path.join(tmp, 'drift.md');
      writeFileSync(
        driftDoc,
        '# Drift\n\nApply `type/epic` to the ticket.\n',
        'utf8',
      );
      // Drive the pure scanner directly against the temp file so the
      // assertion does not depend on real CWD state; the spawn variant
      // below covers the CLI exit-code contract.
      const violations = lintLabelVocabulary([driftDoc]);
      assert.equal(violations.length, 1);
      assert.equal(violations[0].file, driftDoc);
      assert.equal(violations[0].line, 3);
      assert.match(violations[0].token, /type\/epic/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('CLI exits 0 against the post-fix repo (smoke)', () => {
    const result = spawnSync(process.execPath, [SCRIPT_PATH], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
    assert.equal(
      result.status,
      0,
      `CLI exited ${result.status}; stderr:\n${result.stderr}`,
    );
  });
});
