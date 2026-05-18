// tests/lib/orchestration/lifecycle/merge-lockout-lint.test.js
/**
 * Unit tests for the merge-lockout rule in `check-lifecycle-lint.js`
 * (Story #2253 / Task #2255).
 *
 * Acceptance contract:
 *   - A synthetic file under `.agents/scripts/**` containing the
 *     literal `gh pr merge --auto` as a string literal IS flagged.
 *   - The same literal inside `.../listeners/automerge-armer.js` is
 *     NOT flagged (allow-list).
 *   - The literal inside a comment is NOT flagged (comments are
 *     stripped before the literal scan).
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  findMergeLockoutViolations,
  stripComments,
} from '../../../../.agents/scripts/check-lifecycle-lint.js';

/**
 * Build an in-tmp fixture tree shaped like the production layout so
 * the suffix-based allow-list bites correctly. Returns the root path
 * the test should hand to `findMergeLockoutViolations`.
 */
function makeFixtureTree(files) {
  const root = mkdtempSync(path.join(tmpdir(), 'merge-lockout-'));
  for (const [relPath, content] of Object.entries(files)) {
    const abs = path.join(root, relPath);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content, 'utf8');
  }
  return root;
}

describe('stripComments', () => {
  it('preserves string literals containing comment-like sequences', () => {
    const input = `const s = "// not a comment"; const t = '/* still not */';`;
    const out = stripComments(input);
    assert.match(out, /"\/\/ not a comment"/);
    assert.match(out, /'\/\* still not \*\/'/);
  });

  it('removes line comments and block comments', () => {
    const input = 'a // forbidden line\nb /* forbidden block */ c';
    const out = stripComments(input);
    assert.ok(!out.includes('forbidden line'));
    assert.ok(!out.includes('forbidden block'));
  });

  it('preserves line numbers across block-comment newlines', () => {
    const input = 'line1\n/*\nblock\n*/\nline5';
    const out = stripComments(input);
    const lines = out.split('\n');
    // 5 lines preserved (line1, "", "", "", line5)
    assert.equal(lines.length, 5);
    assert.equal(lines[0].trim(), 'line1');
    assert.equal(lines[4].trim(), 'line5');
  });
});

describe('findMergeLockoutViolations', () => {
  it('flags a synthetic `gh pr merge --auto` string literal added to epic-deliver-finalize.js', () => {
    const root = makeFixtureTree({
      'epic-deliver-finalize.js':
        'const cmd = "gh pr merge --auto --squash";\nexport {};',
    });
    const violations = findMergeLockoutViolations(root, { read: readFileSync });
    assert.equal(violations.length, 1, 'one violation flagged');
    assert.match(violations[0].file, /epic-deliver-finalize\.js$/);
    assert.equal(violations[0].line, 1);
    assert.match(violations[0].hint, /gh pr merge/);
    assert.match(violations[0].hint, /automerge-armer\.js/);
  });

  it('does NOT flag the same literal inside automerge-armer.js (allow-list)', () => {
    const armerRel = path.join(
      'lib',
      'orchestration',
      'lifecycle',
      'listeners',
      'automerge-armer.js',
    );
    const root = makeFixtureTree({
      [armerRel]:
        'export const cmd = "gh pr merge --auto --squash --delete-branch";',
    });
    const violations = findMergeLockoutViolations(root, { read: readFileSync });
    assert.equal(
      violations.length,
      0,
      'automerge-armer.js is exempt — zero violations',
    );
  });

  it('does NOT flag a `gh pr merge` reference inside a comment', () => {
    const root = makeFixtureTree({
      'finalize-shim.js':
        '// We deleted the gh pr merge --auto call here.\nexport {};',
    });
    const violations = findMergeLockoutViolations(root, { read: readFileSync });
    assert.equal(violations.length, 0, 'comments are exempt');
  });

  it('flags a template literal containing `gh pr merge`', () => {
    // Build the fixture source as a concatenation so the test file
    // itself does not embed `${…}` inside a non-template string, which
    // would trigger biome's noTemplateCurlyInString rule.
    const fixtureSrc = `const x = \`running gh pr merge --auto on $\{pr}\`;`;
    const root = makeFixtureTree({ 'thinker.js': fixtureSrc });
    const violations = findMergeLockoutViolations(root, { read: readFileSync });
    assert.equal(violations.length, 1);
  });

  it('respects an explicit `lint-lifecycle-disable` opt-out on the same line', () => {
    const root = makeFixtureTree({
      // Necessary to test the opt-out, even though production code
      // should avoid it without an architectural justification.
      'special.js':
        'const s = "gh pr merge --auto"; // lint-lifecycle-disable: justified',
    });
    const violations = findMergeLockoutViolations(root, { read: readFileSync });
    assert.equal(violations.length, 0);
  });

  it('does NOT flag files that contain only the substring `gh pr` (no `merge`)', () => {
    const root = makeFixtureTree({
      'lister.js': 'const c = "gh pr list --head epic/2172";',
    });
    const violations = findMergeLockoutViolations(root, { read: readFileSync });
    assert.equal(violations.length, 0);
  });
});
