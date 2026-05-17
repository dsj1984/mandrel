/**
 * update-maintainability-baseline.flags.test.js — Story #2202 / Task #2214.
 *
 * Acceptance:
 *   - No flag → CLI invokes `refreshBaseline` with `fullScope=false`
 *     (and `scopeFiles` left unset → service derives diff via
 *     `origin/main..HEAD`).
 *   - `--full-scope` → CLI invokes `refreshBaseline` with `fullScope=true`.
 *   - `--diff-scope <ref>` → CLI surfaces the ref as `baseRef`, leaves
 *     `fullScope` falsy.
 *   - `--diff-scope` + `--full-scope` together → CLI rejects (mutual
 *     exclusion guard).
 *
 * The CLI is a thin wrapper, so the contract is verified at the CLI
 * source level (the same approach used by Task #2215's test). The
 * service-side derivation is covered by `refresh-service.diff-scope`
 * and the end-to-end smoke test under
 * `tests/baselines/refresh-entry-points-migration.test.js`.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const CLI_PATH = path.join(
  REPO_ROOT,
  '.agents',
  'scripts',
  'update-maintainability-baseline.js',
);

describe('update-maintainability-baseline — scope-flag defaults (Task #2214)', () => {
  const source = readFileSync(CLI_PATH, 'utf8');

  it('AC: parses --full-scope explicitly (boolean opt-out flag)', () => {
    assert.match(
      source,
      /argv\.includes\(\s*['"]--full-scope['"]\s*\)/,
      'CLI must inspect argv for --full-scope',
    );
  });

  it('AC: --full-scope branches set fullScope=true on refreshBaseline opts', () => {
    // The wrapper's branch shape is:
    //   if (fullScope) { refreshOpts.fullScope = true; }
    // We pin the assignment shape so the default-flip cannot regress to
    // unconditional fullScope=true without breaking this test.
    assert.match(
      source,
      /if\s*\(\s*fullScope\s*\)\s*\{\s*refreshOpts\.fullScope\s*=\s*true\s*;/,
      'CLI must set refreshOpts.fullScope=true only when --full-scope is supplied',
    );
  });

  it('AC: --diff-scope <ref> surfaces the ref as baseRef on refreshBaseline opts', () => {
    assert.match(
      source,
      /refreshOpts\.baseRef\s*=\s*diffScopeRef\b/,
      'CLI must pass the --diff-scope ref through as baseRef',
    );
  });

  it('AC: no flag → no unconditional fullScope assignment (default flipped to diff-scope)', () => {
    // Pre-Task-#2214 default: an unconditional `refreshOpts.fullScope =
    // true` assignment lived in the no-flag branch. Removing that
    // assignment is the load-bearing diff; if it returns, the default
    // regresses to "rewrite everything". The only fullScope assignment
    // permitted is inside the `if (fullScope)` block.
    const fullScopeAssignments = [
      ...source.matchAll(/refreshOpts\.fullScope\s*=\s*true/g),
    ];
    assert.equal(
      fullScopeAssignments.length,
      1,
      `Expected exactly one refreshOpts.fullScope=true assignment (the --full-scope branch), found ${fullScopeAssignments.length}`,
    );
  });

  it('AC: --diff-scope and --full-scope are mutually exclusive (CLI rejects both)', () => {
    assert.match(
      source,
      /fullScope\s*&&\s*diffScopeRef\s*!==\s*null/,
      'CLI must reject the combination of --diff-scope and --full-scope',
    );
  });
});
