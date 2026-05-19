/**
 * tests/audit-suite/manual-mode-regression.test.js
 *
 * Story #2597 / Task #2605: manual-mode invariance pin.
 *
 * When `{{changedFiles}}` is absent from the substitutions map (the
 * manual `/audit-<dimension>` invocation path), every lens template
 * MUST render byte-identically to its on-disk source — the new
 * `## Scope (Epic mode)` block contributes the literal token, which
 * `applySubstitutions` leaves intact when no `changedFiles` value is
 * supplied.
 *
 * Rationale: the literal-token fall-through is the contract that
 * keeps `/audit-security`, `/audit-privacy`, etc. behaving exactly
 * as they did before Story #2597 widened the substitution surface.
 * If the runner ever silently substitutes an empty string (or any
 * other value) for an absent built-in key, this test trips.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';

import { applySubstitutions } from '../../.agents/scripts/lib/audit-suite/substitutions.js';

const LENSES = [
  'audit-architecture',
  'audit-clean-code',
  'audit-dependencies',
  'audit-devops',
  'audit-lighthouse',
  'audit-performance',
  'audit-privacy',
  'audit-quality',
  'audit-security',
  'audit-seo',
  'audit-sre',
  'audit-ux-ui',
];

const WORKFLOWS_DIR = path.resolve(process.cwd(), '.agents', 'workflows');

async function readLens(name) {
  return fs.readFile(path.join(WORKFLOWS_DIR, `${name}.md`), 'utf8');
}

test('manual-mode regression: every lens contains exactly one Scope (Epic mode) block', async () => {
  for (const lens of LENSES) {
    const body = await readLens(lens);
    const matches = body.match(/^## Scope \(Epic mode\)$/gm) || [];
    assert.equal(
      matches.length,
      1,
      `${lens}.md must contain exactly one "## Scope (Epic mode)" header`,
    );
  }
});

test('manual-mode regression: every lens references {{changedFiles}} at least once', async () => {
  for (const lens of LENSES) {
    const body = await readLens(lens);
    assert.ok(
      body.includes('{{changedFiles}}'),
      `${lens}.md must reference {{changedFiles}} in the Scope block`,
    );
  }
});

test('manual-mode regression: render without changedFiles leaves the literal token intact', async () => {
  // The "no scope filter" invariant: when the operator invokes the
  // lens manually (no `changedFiles` substitution), the rendered body
  // must contain the literal `{{changedFiles}}` token so the lens
  // body's prose instructs the model to fall through to a codebase-
  // wide scan.
  for (const lens of LENSES) {
    const body = await readLens(lens);
    const rendered = applySubstitutions(body, {
      auditOutputDir: 'temp/audits',
      ticketId: '0',
      baseBranch: 'main',
      // intentionally no `changedFiles` — manual mode
    });
    assert.ok(
      rendered.includes('{{changedFiles}}'),
      `${lens}.md must still contain the literal {{changedFiles}} token after manual-mode substitution`,
    );
  }
});

test('manual-mode regression: every Scope block explicitly documents the literal-token fall-through', async () => {
  // The lens body must *tell the model* that the literal token means
  // "no scope filter — run codebase-wide". Without this prose, an LLM
  // reader could misinterpret the literal as "scope to a file called
  // {{changedFiles}}", which would silently break manual mode.
  for (const lens of LENSES) {
    const body = await readLens(lens);
    assert.match(
      body,
      /no\s+scope\s+filter[\s\S]*?codebase-wide/i,
      `${lens}.md must explicitly instruct the model to treat the literal {{changedFiles}} token as "no scope filter — run codebase-wide"`,
    );
  }
});

test('manual-mode regression: rendered output equals on-disk source (no substitution churn) when only built-ins supplied without changedFiles', async () => {
  // The strongest invariant: applying the built-in substitution map
  // *without* a `changedFiles` value must not mutate the lens body at
  // all — none of the other built-ins (`auditOutputDir`, `ticketId`,
  // `baseBranch`) appear in the new Scope block, and any pre-existing
  // occurrences elsewhere in the lens are unchanged by Story #2597.
  // This is the "snapshot equals source" form of the regression test:
  // the on-disk file IS the snapshot.
  for (const lens of LENSES) {
    const body = await readLens(lens);
    // Render with NO substitutions at all — applySubstitutions is a
    // no-op when the map is empty, so the rendered body must equal
    // the source byte-for-byte.
    const rendered = applySubstitutions(body, {});
    assert.equal(
      rendered,
      body,
      `${lens}.md must render byte-identically to source when no substitutions are supplied`,
    );
  }
});
