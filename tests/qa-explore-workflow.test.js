/**
 * /qa-explore workflow contract (Epic #3798 / Story #3812, f3-qa-explore-agent-led).
 *
 * `/qa-explore` is the **agent-led** front-end of exploratory QA: the agent
 * Plans a surface with an explicit static-vs-drive method choice, DRIVES it
 * itself (browser MCP or static), and captures ledger items read-only — a
 * bounded per-surface session, HITL-gated at every phase transition, routed
 * through the shared dedup/coverage/classification/missing-test/redaction/
 * session core. Its human-led sibling is `/qa-assist`; no human-driven flow
 * remains in `/qa-explore`.
 *
 * This spec is a structural assertion over the authored workflow source — it
 * does not execute the workflow (that is the host LLM's job), it pins the
 * load-bearing contract:
 *
 *   1. `.agents/workflows/qa-explore.md` exists and is projected by
 *      sync-commands (top-level `.md`, with a `description` frontmatter block).
 *   2. It defines Plan, Capture, and Triage sections.
 *   3. It adopts the `qa-engineer` persona.
 *   4. It is agent-led: the agent drives the surface, with an explicit
 *      static-vs-drive method choice made at Plan time, and runs as a bounded
 *      per-surface session.
 *   5. Capture is declared read-only and every phase transition is
 *      operator-gated (HITL).
 *   6. No human-driven flow remains — it points to `/qa-assist` for that.
 *   7. It references the qa-explore-driving skill plus the route-finding,
 *      classify-finding, coverage-verdict, propose-missing-test,
 *      redact-evidence, qa-session, and resolve-qa-contract helpers, the
 *      ledger schema, and the core/qa-coverage-mapping skill by path.
 *   8. It writes its ledger under temp/qa/.
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

  it('describes itself as agent-led in the frontmatter description', () => {
    const frontmatter = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/)?.[1];
    assert.ok(frontmatter, 'frontmatter block must be present');
    assert.match(
      frontmatter,
      /agent-led/i,
      'the generated workflows.md row (sourced from this description) must call /qa-explore agent-led',
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

  it('is agent-led: the agent drives the surface itself', () => {
    assert.match(
      source,
      /agent-led/i,
      'workflow must declare itself agent-led',
    );
    assert.match(
      source,
      /agent drives/i,
      'workflow must state that the agent drives the surface (not the human)',
    );
    // The Capture phase header must signal that the agent drives there.
    assert.match(
      source,
      /##\s+Phase 2 — Capture \(agent drives, READ-ONLY\)/,
      'Capture phase header must declare the agent drives, read-only',
    );
  });

  it('makes an explicit static-vs-drive method choice at Plan time', () => {
    // The Plan phase must offer both driving methods as an explicit choice.
    const planSection =
      source.match(/##\s+Phase 1 — Plan([\s\S]*?)(?:\r?\n---\r?\n)/)?.[1] ?? '';
    assert.match(
      planSection,
      /Choose the driving method explicitly/i,
      'Plan phase must make the driving method an explicit choice',
    );
    assert.match(
      planSection,
      /Drive \(default\)/,
      'Plan phase must offer driving the running app as the default method',
    );
    assert.match(
      planSection,
      /Static \(documented interim\)/,
      'Plan phase must offer static driving as the documented interim method',
    );
  });

  it('drives via the browser MCP by default and static as the documented interim', () => {
    assert.match(
      source,
      /browser MCP/i,
      'workflow must name the browser MCP as the default driving channel',
    );
    assert.match(
      source,
      /navigation-first/i,
      'driving must be navigation-first',
    );
    assert.match(
      source,
      /static driving|Static \(documented interim\)/i,
      'workflow must document static driving as the interim method',
    );
  });

  it('runs as a bounded per-surface session', () => {
    assert.match(
      source,
      /bounded[\s\S]*?per-surface|per-surface[\s\S]*?bounded/i,
      'workflow must describe a bounded per-surface session',
    );
    assert.match(
      source,
      /one surface per session|single bounded session over one named surface/i,
      'workflow must bound the session to a single named surface',
    );
  });

  it('removes the human-driven flow and points to /qa-assist for it', () => {
    assert.match(
      source,
      /qa-assist/,
      'workflow must reference /qa-assist as the human-led sibling',
    );
    assert.match(
      source,
      /No human-driven flow lives in `\/qa-explore`|no human-driven flow lives here/i,
      'workflow must declare that no human-driven flow remains in qa-explore',
    );
  });

  it('declares the Capture phase read-only', () => {
    assert.match(
      source,
      /Capture[\s\S]*?read-only/i,
      'Capture phase must be declared read-only',
    );
  });

  it('holds the read-only capture invariant while the agent drives', () => {
    assert.match(
      source,
      /Read-only invariant/i,
      'workflow must state the read-only capture invariant',
    );
    assert.match(
      source,
      /Never enter real credentials/i,
      'driving must never enter real credentials for an authenticated surface',
    );
    assert.match(
      source,
      /finding, not a workaround/i,
      'broken navigation must be recorded as a finding, not routed around',
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

  it('references the qa-explore-driving skill, every wired helper, schema, and skill by path', () => {
    const referencedPaths = [
      '.agents/skills/stack/qa/qa-explore-driving/SKILL.md',
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
