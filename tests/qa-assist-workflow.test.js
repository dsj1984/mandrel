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
import { assertDocMentions, assertDocOmits } from './helpers/doc-assert.js';

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
// The shared contract/session/redaction/QaLedgerItem/triage/HITL machinery is
// single-homed in helpers/qa-core.md (Story #4666); the workflow references it
// by pointer. Assert wired-helper paths against the union of the two so the
// guard stays meaningful without forcing the workflow to restate the core.
const QA_CORE_PATH = path.join(
  REPO_ROOT,
  '.agents',
  'workflows',
  'helpers',
  'qa-core.md',
);

const source = readFileSync(WORKFLOW_PATH, 'utf8');
const coreSource = readFileSync(QA_CORE_PATH, 'utf8');
const combinedSource = `${source}\n${coreSource}`;

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
    assertDocMentions(
      source,
      /##\s+Phase 1 — Intake/,
      'missing Intake section',
    );
    assertDocMentions(
      source,
      /##\s+Phase 2 — Enrich/,
      'missing Enrich section',
    );
    assertDocMentions(
      source,
      /##\s+Phase 3 — Record/,
      'missing Record section',
    );
  });

  it('frames the agent as a quality gatekeeper without a persona pack', () => {
    assertDocMentions(
      source,
      /quality gatekeeper/i,
      'workflow must frame QA role in prose',
    );
    assertDocOmits(
      source,
      /personas\/qa-engineer\.md/,
      'workflow must not reference deleted persona files',
    );
  });

  it('is human-led: ingests a human observation and asks clarifying questions when ambiguous', () => {
    assertDocMentions(
      source,
      /human-led/i,
      'workflow must declare itself human-led',
    );
    assertDocMentions(
      source,
      /observation/i,
      'workflow must ingest a human observation',
    );
    assertDocMentions(
      source,
      /clarifying questions[\s\S]*?ambiguous/i,
      'workflow must ask clarifying questions when the observation is ambiguous',
    );
  });

  it('enriches with repro, root-cause file:line, and a coverage verdict', () => {
    assertDocMentions(source, /repro/i, 'must establish a repro');
    assertDocMentions(source, /root[\s-]cause/i, 'must locate a root cause');
    assertDocMentions(
      source,
      /file:line/i,
      'must name the root cause as a file:line locus',
    );
    assertDocMentions(
      source,
      /coverage verdict/i,
      'must compute a coverage verdict',
    );
  });

  it('defaults to a persistent, resumable rolling session', () => {
    assertDocMentions(
      source,
      /persistent/i,
      'must default to a persistent session',
    );
    assertDocMentions(source, /resumable|resume/i, 'must be resumable');
    assertDocMentions(source, /rolling/i, 'must be a rolling session');
  });

  it('gates every phase transition and every write on explicit operator confirmation (HITL)', () => {
    assertDocMentions(
      source,
      /Intake\s*→\s*Enrich/,
      'must name the Intake → Enrich gate',
    );
    assertDocMentions(
      source,
      /Enrich\s*→\s*Record/,
      'must name the Enrich → Record gate',
    );
    assertDocMentions(
      source,
      /explicit operator confirmation/i,
      'transitions must require explicit operator confirmation',
    );
    assertDocMentions(
      source,
      /every write/i,
      'every write must be operator-gated',
    );
  });

  it('redacts before any evidence reaches disk or GitHub', () => {
    assertDocMentions(
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
      // distinctive tail so the test is robust to the relative prefix. Shared-
      // core helpers now live in helpers/qa-core.md, so check the union.
      const tail = ref.replace(/^\.agents\//, '');
      assert.ok(
        combinedSource.includes(tail),
        `qa-assist.md (or helpers/qa-core.md) must reference ${ref} (looked for "${tail}")`,
      );
    }
  });

  it('writes its ledger under temp/qa/', () => {
    assertDocMentions(
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
