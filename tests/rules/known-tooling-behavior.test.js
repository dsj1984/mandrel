/**
 * tests/rules/known-tooling-behavior.test.js — the anti-rot ratchet for
 * `docs/contributing/known-tooling-behavior.md` (Story #4825, AC-1 / AC-2 / AC-3).
 *
 * The rule's whole value is that an agent can trust it without re-measuring.
 * That trust is only earned if two properties hold structurally rather than by
 * review:
 *
 *   AC-2 — every entry carries a reproduction command, so a reader can confirm
 *          the behavior still holds instead of taking the prose on faith.
 *   AC-3 — every repository path an entry names still exists, so the rule
 *          cannot decay into confident misinformation about files that were
 *          renamed or deleted.
 *
 * These are structure assertions over the document, not assertions that the
 * documented behaviors reproduce — running six gates inside a unit test would
 * be a slow, flaky integration suite wearing a unit test's clothes. The
 * reproduction command is the artifact under test; running it stays the
 * reader's job.
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const RULE_PATH = path.join(
  REPO_ROOT,
  'docs',
  'contributing',
  'known-tooling-behavior.md',
);
const RULE_REL = 'docs/contributing/known-tooling-behavior.md';

const source = readFileSync(RULE_PATH, 'utf8');

/**
 * Split the rule into its numbered entries. An entry is an `##` section whose
 * heading starts with a digit — the `# ` title and the `## The entry bar`
 * preamble are deliberately excluded, because they carry policy rather than a
 * measured behavior.
 *
 * @returns {Array<{ heading: string, body: string }>}
 */
function entries() {
  const found = [];
  const lines = source.split('\n');
  let current = null;

  for (const line of lines) {
    const heading = /^## (.+)$/.exec(line);
    if (heading) {
      if (current) found.push(current);
      current = /^\d/.test(heading[1])
        ? { heading: heading[1], body: '' }
        : null;
      continue;
    }
    if (current) current.body += `${line}\n`;
  }
  if (current) found.push(current);
  return found;
}

/**
 * Extract the fenced `bash` blocks inside an entry body.
 *
 * @param {string} body
 * @returns {string[]}
 */
function bashBlocks(body) {
  return [...body.matchAll(/```bash\n([\s\S]*?)```/g)].map((m) => m[1]);
}

/**
 * Repository-path tokens named anywhere in an entry (prose code spans and
 * reproduction commands alike).
 *
 * A candidate must contain a `/` — a bare `probe.js` in a reproduction command
 * is a scratch artifact the command itself creates, not a repository path, and
 * asserting its existence would be wrong. Glob patterns are skipped for the
 * same reason: `.agents/workflows/` wildcards name a set, not a file.
 *
 * The extension alternation is ordered longest-first and anchored with `\b`:
 * an unordered `js|json` truncates `baselines/dead-exports.json` to
 * `…/dead-exports.js` and reports a phantom missing file.
 *
 * @param {string} body
 * @returns {string[]}
 */
function pathTokens(body) {
  const matches =
    body.match(
      /(?:\.?[\w@.-]+\/)+[\w@.-]+\.(?:json|mjs|cjs|js|md|yaml|yml)\b/g,
    ) ?? [];
  return [...new Set(matches)].filter((token) => !token.includes('*'));
}

describe('known-tooling-behavior rule shape (Story #4825, AC-1)', () => {
  it('opens with the on-demand scope header', () => {
    const head = source.split('\n').slice(0, 5).join('\n');
    assert.match(
      head,
      /applies when/i,
      `${RULE_REL} must open with the standard "applies when…" scope header so a ` +
        'reader can decide in one line whether to read on — that header is what ' +
        'makes it an on-demand rule rather than resident context',
    );
  });

  it('carries at least one entry', () => {
    assert.ok(
      entries().length > 0,
      `${RULE_REL} has no numbered entries — an empty rule still costs a § 1.F ` +
        'listing and teaches nothing',
    );
  });
});

describe('every entry carries a reproduction command (AC-2)', () => {
  for (const entry of entries()) {
    it(`"${entry.heading}" has a runnable bash reproduction`, () => {
      const blocks = bashBlocks(entry.body);
      assert.ok(
        blocks.length >= 1,
        `entry "${entry.heading}" in ${RULE_REL} has no \`\`\`bash block. Every entry ` +
          'must be confirmable by running something — an entry a reader cannot ' +
          're-measure is trusted forever and deleted never',
      );
      assert.ok(
        blocks.some((block) =>
          block
            .split('\n')
            .some((line) => line.trim() && !line.trim().startsWith('#')),
        ),
        `entry "${entry.heading}" in ${RULE_REL} has a bash block containing only ` +
          'comments — there is no command to run',
      );
    });
  }
});

describe('every path an entry names still exists (AC-3)', () => {
  for (const entry of entries()) {
    it(`"${entry.heading}" names only live repository paths`, () => {
      for (const token of pathTokens(entry.body)) {
        assert.ok(
          existsSync(path.join(REPO_ROOT, token)),
          `entry "${entry.heading}" in ${RULE_REL} names "${token}", which no longer ` +
            'exists. Re-measure the behavior against the current tree and rewrite ' +
            'the entry, or delete it — a rule that cites a dead path is confident ' +
            'misinformation',
        );
      }
    });
  }
});

describe('the rule stays on-demand, not resident (AC-4 / AC-5 / AC-7)', () => {
  it('is contributor documentation, absent from the § 1.F rule list (Story #5381)', () => {
    const instructions = readFileSync(
      path.join(REPO_ROOT, '.agents', 'instructions.md'),
      'utf8',
    );
    assert.ok(
      !instructions.includes('known-tooling-behavior.md'),
      '.agents/instructions.md § 1.F must not list known-tooling-behavior.md — it ' +
        "describes mandrel's own gates, lives under docs/contributing/, and does " +
        'not ship in the .agents payload',
    );
  });

  it('is reachable from the story-worker role context by link, not by @-import', () => {
    const worker = readFileSync(
      path.join(REPO_ROOT, '.agents', 'agents', 'story-worker.md'),
      'utf8',
    );
    assert.ok(
      worker.includes('known-tooling-behavior.md'),
      '.agents/agents/story-worker.md must name the rule — role-scoped agents boot ' +
        'without the entry-doc closure, so a § 1.F listing alone never reaches the ' +
        'agent that actually runs close-validation',
    );
    assert.ok(
      !worker.includes('@../../.agents/rules/known-tooling-behavior.md'),
      '.agents/agents/story-worker.md must link the rule, not @-import it — an ' +
        '@-import makes it always-loaded for that agent and defeats the on-demand design',
    );
  });

  it('is absent from the always-on entry-doc closure', () => {
    const entryDoc = readFileSync(path.join(REPO_ROOT, 'AGENTS.md'), 'utf8');
    assert.ok(
      !entryDoc.includes('known-tooling-behavior'),
      'AGENTS.md must not @-import the rule — it is on-demand, and the always-loaded ' +
        'closure is re-paid on every session and every subagent spawn',
    );
  });
});
