/**
 * lib/audit-suite/__tests__/dependencies-routing.test.js — the audit-dependencies
 * lockfile-routing selector gate (Story #4632).
 *
 * The reworked dependencies lens runs a supply-chain delta pass in its scoped
 * mode, which only fires when a change set that bumps a lockfile actually
 * selects the lens. That routing is data: the `filePatterns` on the
 * `audit-dependencies` entry in `audit-rules.json`. This test pins the
 * contract by driving the SAME `matchesAnyFilePattern` matcher `selectAudits`
 * uses over the REAL on-disk manifest, so a future edit that drops the lockfile
 * globs (or narrows them) fails here instead of silently disabling the
 * supply-chain pass at close time.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { matchesAnyFilePattern } from '../selector.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const AUDIT_RULES_PATH = path.resolve(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  'schemas',
  'audit-rules.json',
);

/** @returns {string[]} the audit-dependencies entry's registered filePatterns. */
function dependencyFilePatterns() {
  const rules = JSON.parse(fs.readFileSync(AUDIT_RULES_PATH, 'utf8'));
  const entry = rules.audits?.['audit-dependencies'];
  assert.ok(entry, 'audit-dependencies is not registered in audit-rules.json');
  return entry.triggers?.filePatterns ?? [];
}

describe('audit-dependencies lockfile routing (Story #4632)', () => {
  it('selects the lens for a package-lock.json change', () => {
    assert.equal(
      matchesAnyFilePattern(dependencyFilePatterns(), ['package-lock.json']),
      true,
    );
  });

  it('selects the lens for a nested package-lock.json change', () => {
    assert.equal(
      matchesAnyFilePattern(dependencyFilePatterns(), [
        'packages/api/package-lock.json',
      ]),
      true,
    );
  });

  it('selects the lens for pnpm and yarn lockfiles', () => {
    const patterns = dependencyFilePatterns();
    assert.equal(matchesAnyFilePattern(patterns, ['pnpm-lock.yaml']), true);
    assert.equal(matchesAnyFilePattern(patterns, ['yarn.lock']), true);
  });

  it('does not select the lens for an unrelated source-only change', () => {
    assert.equal(
      matchesAnyFilePattern(dependencyFilePatterns(), [
        'src/index.js',
        'docs/readme.md',
      ]),
      false,
    );
  });
});
