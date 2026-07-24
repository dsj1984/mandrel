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
 *   9. Plan resolves the target environment via resolveQaEnvironment
 *      (prompting when ambiguous) and records the environment name on the
 *      ledger; static is re-scoped to the no-seam case and authenticated
 *      driving follows the per-environment signInSeam (Epic #4326 / #4329).
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
  'qa-explore.md',
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
    assertDocMentions(source, /##\s+Phase 1 — Plan/, 'missing Plan section');
    assertDocMentions(
      source,
      /##\s+Phase 2 — Capture/,
      'missing Capture section',
    );
    assertDocMentions(
      source,
      /##\s+Phase 3 — Triage/,
      'missing Triage section',
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

  it('is agent-led: the agent drives the surface itself', () => {
    assertDocMentions(
      source,
      /agent-led/i,
      'workflow must declare itself agent-led',
    );
    assertDocMentions(
      source,
      /agent drives/i,
      'workflow must state that the agent drives the surface (not the human)',
    );
    // The Capture phase header must signal that the agent drives there.
    assertDocMentions(
      source,
      /##\s+Phase 2 — Capture \(agent drives, READ-ONLY\)/,
      'Capture phase header must declare the agent drives, read-only',
    );
  });

  it('makes an explicit static-vs-drive method choice at Plan time', () => {
    // The Plan phase must offer both driving methods as an explicit choice.
    const planSection =
      source.match(/##\s+Phase 1 — Plan([\s\S]*?)(?:\r?\n---\r?\n)/)?.[1] ?? '';
    assertDocMentions(
      planSection,
      /Choose the driving method explicitly/i,
      'Plan phase must make the driving method an explicit choice',
    );
    assertDocMentions(
      planSection,
      /Drive \(default\)/,
      'Plan phase must offer driving the running app as the default method',
    );
    assertDocMentions(
      planSection,
      /Static \(documented interim\)/,
      'Plan phase must offer static driving as the documented interim method',
    );
  });

  it('drives via the browser MCP by default and static as the documented interim', () => {
    assertDocMentions(
      source,
      /browser MCP/i,
      'workflow must name the browser MCP as the default driving channel',
    );
    assertDocMentions(
      source,
      /navigation-first/i,
      'driving must be navigation-first',
    );
    assertDocMentions(
      source,
      /static driving|Static \(documented interim\)/i,
      'workflow must document static driving as the interim method',
    );
  });

  it('runs as a bounded per-surface session', () => {
    assertDocMentions(
      source,
      /bounded[\s\S]*?per-surface|per-surface[\s\S]*?bounded/i,
      'workflow must describe a bounded per-surface session',
    );
    assertDocMentions(
      source,
      /one surface per session|single bounded session over one named surface/i,
      'workflow must bound the session to a single named surface',
    );
  });

  it('removes the human-driven flow and points to /qa-assist for it', () => {
    assertDocMentions(
      source,
      /qa-assist/,
      'workflow must reference /qa-assist as the human-led sibling',
    );
    assertDocMentions(
      source,
      /No human-driven flow lives in `\/qa-explore`|no human-driven flow lives here/i,
      'workflow must declare that no human-driven flow remains in qa-explore',
    );
  });

  it('declares the Capture phase read-only', () => {
    assertDocMentions(
      source,
      /Capture[\s\S]*?read-only/i,
      'Capture phase must be declared read-only',
    );
  });

  it('holds the read-only capture invariant while the agent drives', () => {
    assertDocMentions(
      source,
      /Read-only invariant/i,
      'workflow must state the read-only capture invariant',
    );
    assertDocMentions(
      source,
      /Never type real credentials inline/i,
      'driving must never type real credentials inline for an authenticated surface',
    );
    assertDocMentions(
      source,
      /finding, not a workaround/i,
      'broken navigation must be recorded as a finding, not routed around',
    );
  });

  it('resolves the target environment via resolveQaEnvironment at Plan time', () => {
    const planSection =
      source.match(/##\s+Phase 1 — Plan([\s\S]*?)(?:\r?\n---\r?\n)/)?.[1] ?? '';
    assertDocMentions(
      planSection,
      /resolveQaEnvironment/,
      'Plan phase must resolve the target environment via resolveQaEnvironment',
    );
    assertDocMentions(
      planSection,
      /prompt/i,
      'Plan phase must prompt the operator when the target environment is ambiguous',
    );
    assertDocMentions(
      planSection,
      /record the resolved\s+\*\*environment name\*\*/i,
      'Plan phase must record the resolved environment name on the ledger alongside the driving method',
    );
  });

  it('re-scopes static as the interim only where no seam resolves, not a forced authenticated fallback', () => {
    // The retired forced-fallback wording must be gone: exploratory QA can now
    // drive authenticated deployed surfaces through the per-environment seam.
    assertDocOmits(
      source,
      /does not deliver/i,
      'the forced authenticated-driving fallback wording must be retired',
    );
    // Authenticated driving is now seam-based, including deployed hosts.
    assertDocMentions(
      source,
      /signInSeam/,
      'authenticated driving must reference the per-environment signInSeam',
    );
    assertDocMentions(
      source,
      /credentialRef/,
      'the skill seam must reference credentialRef-indirected sign-in',
    );
    // Static is now scoped to the no-seam case, not the authenticated case.
    assertDocMentions(
      source,
      /no seam resolves/i,
      'static must be documented as the interim only where no seam resolves',
    );
  });

  it('references the resolve-qa-contract environment resolver by path', () => {
    assert.ok(
      source.includes('scripts/lib/qa/resolve-qa-contract.js'),
      'qa-explore.md must reference resolve-qa-contract.js (resolveQaEnvironment home)',
    );
  });

  it('gates every phase transition on explicit operator confirmation (HITL)', () => {
    assertDocMentions(
      source,
      /Plan\s*→\s*Capture/,
      'must name the Plan → Capture gate',
    );
    assertDocMentions(
      source,
      /Capture\s*→\s*Triage/,
      'must name the Capture → Triage gate',
    );
    assertDocMentions(
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
      // distinctive tail so the test is robust to the relative prefix. Shared-
      // core helpers now live in helpers/qa-core.md, so check the union.
      const tail = ref.replace(/^\.agents\//, '');
      assert.ok(
        combinedSource.includes(tail),
        `qa-explore.md (or helpers/qa-core.md) must reference ${ref} (looked for "${tail}")`,
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
});
