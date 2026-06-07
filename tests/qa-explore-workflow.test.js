/**
 * /qa-explore workflow contract (Epic #3686 / Story #3725, f3-qa-explore-core).
 *
 * The integration capstone wires the QA helpers (dedup/route, classification,
 * coverage verdict, missing-test proposal, redaction, session/resume) into an
 * operator-facing HITL Plan → Capture → Triage loop. This spec is a structural
 * assertion over the authored workflow source — it does not execute the
 * workflow (that is the host LLM's job), it pins the load-bearing contract:
 *
 *   1. `.agents/workflows/qa-explore.md` exists and is projected by
 *      sync-commands (top-level `.md`, with a `description` frontmatter block).
 *   2. It defines Plan, Capture, and Triage sections.
 *   3. It adopts the `qa-engineer` persona.
 *   4. Capture is declared read-only and every phase transition is
 *      operator-gated (HITL).
 *   5. It references the route-finding, classify-finding, coverage-verdict,
 *      propose-missing-test, redact-evidence, qa-session, and
 *      resolve-qa-contract helpers, the ledger schema, and the
 *      core/qa-coverage-mapping skill by path.
 *   6. It writes its ledger under temp/qa/.
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
  'qa-explore.md',
);

const source = readFileSync(WORKFLOW_PATH, 'utf8');

describe('qa-explore workflow contract', () => {
  it('opens with a YAML frontmatter description block so sync-commands projects it', () => {
    // applyHeader() only keeps the description when `---` is the first thing in
    // the file; assert the frontmatter is on line 1 with a description key.
    assert.match(
      source,
      /^---\r?\n[\s\S]*?\bdescription:[\s\S]*?\r?\n---\r?\n/,
      'qa-explore.md must begin with a YAML frontmatter block carrying a description',
    );
  });

  it('defines Plan, Capture, and Triage sections', () => {
    assert.match(source, /##\s+Phase 1 — Plan/, 'missing Plan section');
    assert.match(source, /##\s+Phase 2 — Capture/, 'missing Capture section');
    assert.match(source, /##\s+Phase 3 — Triage/, 'missing Triage section');
  });

  it('adopts the qa-engineer persona', () => {
    assert.match(
      source,
      /qa-engineer/,
      'workflow must adopt the qa-engineer persona',
    );
    assert.match(
      source,
      /personas\/qa-engineer\.md/,
      'workflow must reference the qa-engineer persona file by path',
    );
  });

  it('declares the Capture phase read-only', () => {
    assert.match(
      source,
      /Capture[\s\S]*?read-only/i,
      'Capture phase must be declared read-only',
    );
  });

  it('gates every phase transition on explicit operator confirmation (HITL)', () => {
    assert.match(
      source,
      /Plan\s*→\s*Capture/,
      'must name the Plan → Capture gate',
    );
    assert.match(
      source,
      /Capture\s*→\s*Triage/,
      'must name the Capture → Triage gate',
    );
    assert.match(
      source,
      /explicit operator confirmation/i,
      'transitions must require explicit operator confirmation',
    );
  });

  it('references every wired helper, schema, and skill by path', () => {
    const referencedPaths = [
      '.agents/scripts/lib/findings/route-finding.js',
      '.agents/scripts/lib/findings/classify-finding.js',
      '.agents/scripts/lib/qa/coverage-verdict.js',
      '.agents/scripts/lib/qa/propose-missing-test.js',
      '.agents/scripts/lib/qa/redact-evidence.js',
      '.agents/scripts/lib/qa/qa-session.js',
      '.agents/scripts/lib/qa/resolve-qa-contract.js',
      '.agents/schemas/qa-ledger.schema.json',
      '.agents/skills/core/qa-coverage-mapping',
    ];
    for (const ref of referencedPaths) {
      // The workflow links to siblings with `../`-relative paths; assert on the
      // distinctive tail so the test is robust to the relative prefix.
      const tail = ref.replace(/^\.agents\//, '');
      assert.ok(
        source.includes(tail),
        `qa-explore.md must reference ${ref} (looked for "${tail}")`,
      );
    }
  });

  it('writes its ledger under temp/qa/', () => {
    assert.match(
      source,
      /temp\/qa\//,
      'workflow must write its ledger under temp/qa/',
    );
  });
});
