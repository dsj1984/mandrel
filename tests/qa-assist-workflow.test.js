/**
 * /qa-assist workflow contract (Epic #3798 / Story #3811, f2-qa-assist).
 *
 * The human-led front-end ingests a single operator observation, enriches it
 * (repro + root-cause file:line + coverage verdict), asks clarifying questions
 * when the observation is ambiguous, and appends a redacted ledger item to a
 * persistent, resumable rolling session under temp/qa/. This spec is a
 * structural assertion over the authored workflow source — it does not execute
 * the workflow (that is the host LLM's job); it pins the load-bearing contract:
 *
 *   1. `.agents/workflows/qa-assist.md` exists and is projected by
 *      sync-commands (top-level `.md`, with a `description` frontmatter block).
 *   2. It defines Intake, Enrich, and Record phases.
 *   3. It adopts the `qa-engineer` persona.
 *   4. It is human-led: ingests a human observation and asks clarifying
 *      questions when the observation is ambiguous.
 *   5. It enriches with repro + root-cause (file:line) + a coverage verdict.
 *   6. It defaults to a persistent, resumable rolling session and CONSUMES the
 *      shared core helpers (qa-session, context-hydrator, coverage, classify,
 *      route, promote) rather than reimplementing them.
 *   7. It HITL-gates every phase transition and every write, and runs
 *      redaction before any evidence reaches disk or GitHub.
 *   8. It writes its ledger under temp/qa/<sessionId>.ndjson.
 *   9. The generated `.agents/docs/workflows.md` lists `/qa-assist`.
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
  'qa-assist.md',
);
const WORKFLOWS_DOC_PATH = path.join(
  REPO_ROOT,
  '.agents',
  'docs',
  'workflows.md',
);

const source = readFileSync(WORKFLOW_PATH, 'utf8');

describe('qa-assist workflow contract', () => {
  it('opens with a YAML frontmatter description block so sync-commands projects it', () => {
    // applyHeader() only keeps the description when `---` is the first thing in
    // the file; assert the frontmatter is on line 1 with a description key.
    assert.match(
      source,
      /^---\r?\n[\s\S]*?\bdescription:[\s\S]*?\r?\n---\r?\n/,
      'qa-assist.md must begin with a YAML frontmatter block carrying a description',
    );
  });

  it('defines Intake, Enrich, and Record phases', () => {
    assert.match(source, /##\s+Phase 1 — Intake/, 'missing Intake section');
    assert.match(source, /##\s+Phase 2 — Enrich/, 'missing Enrich section');
    assert.match(source, /##\s+Phase 3 — Record/, 'missing Record section');
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

  it('is human-led: ingests a human observation and asks clarifying questions when ambiguous', () => {
    assert.match(
      source,
      /human-led/i,
      'workflow must declare itself human-led',
    );
    assert.match(
      source,
      /observation/i,
      'workflow must ingest a human observation',
    );
    assert.match(
      source,
      /clarifying questions[\s\S]*?ambiguous/i,
      'workflow must ask clarifying questions when the observation is ambiguous',
    );
  });

  it('enriches with repro, root-cause file:line, and a coverage verdict', () => {
    assert.match(source, /repro/i, 'must establish a repro');
    assert.match(source, /root[\s-]cause/i, 'must locate a root cause');
    assert.match(
      source,
      /file:line/i,
      'must name the root cause as a file:line locus',
    );
    assert.match(
      source,
      /coverage verdict/i,
      'must compute a coverage verdict',
    );
  });

  it('defaults to a persistent, resumable rolling session', () => {
    assert.match(source, /persistent/i, 'must default to a persistent session');
    assert.match(source, /resumable|resume/i, 'must be resumable');
    assert.match(source, /rolling/i, 'must be a rolling session');
  });

  it('gates every phase transition and every write on explicit operator confirmation (HITL)', () => {
    assert.match(
      source,
      /Intake\s*→\s*Enrich/,
      'must name the Intake → Enrich gate',
    );
    assert.match(
      source,
      /Enrich\s*→\s*Record/,
      'must name the Enrich → Record gate',
    );
    assert.match(
      source,
      /explicit operator confirmation/i,
      'transitions must require explicit operator confirmation',
    );
    assert.match(source, /every write/i, 'every write must be operator-gated');
  });

  it('redacts before any evidence reaches disk or GitHub', () => {
    assert.match(
      source,
      /[Rr]edact[\s\S]*?(disk|GitHub|persist)/,
      'must redact before evidence reaches disk or GitHub',
    );
  });

  it('consumes the shared core helpers by path (qa-session, context-hydrator, coverage, classify, route, promote)', () => {
    const referencedPaths = [
      '.agents/scripts/lib/qa/qa-session.js',
      '.agents/scripts/lib/qa/qa-context-hydrator.js',
      '.agents/scripts/lib/qa/coverage-verdict.js',
      '.agents/scripts/lib/qa/redact-evidence.js',
      '.agents/scripts/lib/qa/resolve-qa-contract.js',
      '.agents/scripts/lib/findings/classify-finding.js',
      '.agents/scripts/lib/findings/route-finding.js',
      '.agents/scripts/lib/findings/promote-finding.js',
      '.agents/schemas/qa-ledger.schema.json',
    ];
    for (const ref of referencedPaths) {
      // The workflow links to siblings with `../`-relative paths; assert on the
      // distinctive tail so the test is robust to the relative prefix.
      const tail = ref.replace(/^\.agents\//, '');
      assert.ok(
        source.includes(tail),
        `qa-assist.md must reference ${ref} (looked for "${tail}")`,
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

  it('is listed in the generated workflows catalog doc', () => {
    const doc = readFileSync(WORKFLOWS_DOC_PATH, 'utf8');
    assert.match(
      doc,
      /\|\s*`\/qa-assist`\s*\|/,
      '.agents/docs/workflows.md must list the /qa-assist command',
    );
  });
});
