/**
 * tests/bootstrap/agent-shared-prefix.test.js — shared-prefix agent boots
 * (Story #4708, AC-3).
 *
 * Prompt-cache is keyed on the exact byte prefix of the assembled system
 * prompt, so every `.agents/agents/*.md` role context must begin (after its
 * role-specific YAML frontmatter, which the host strips) with a
 * BYTE-IDENTICAL shared common core, with role-specific content strictly
 * after the `<!-- role-delta:` marker. One diverged byte in the shared block
 * — or a role section reordered ahead of it — silently forfeits the cache
 * hit for every spawn of that role, so this structural test fails on any
 * divergence rather than leaving the regression invisible.
 *
 * The materialized `.claude/agents/` copies inherit the property: the sync
 * header `sync-claude-agents.js` injects is a single static constant shared
 * by all payload agents, so `HEADER + shared core` stays a common prefix.
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const AGENTS_DIR = path.join(REPO_ROOT, '.agents', 'agents');

/** The line that ends the shared common core in every role file. */
const ROLE_DELTA_MARKER = '<!-- role-delta:';

/** Strip leading YAML frontmatter; returns the body after the closing ---. */
function stripFrontmatter(content, fileName) {
  assert.ok(
    content.startsWith('---\n'),
    `${fileName} must open with YAML frontmatter (Claude Code parses name/description from it)`,
  );
  const end = content.indexOf('\n---\n', 4);
  assert.ok(end !== -1, `${fileName} frontmatter never closes`);
  return content.slice(end + '\n---\n'.length);
}

const roleFiles = readdirSync(AGENTS_DIR)
  .filter((f) => f.endsWith('.md'))
  .sort();

describe('role-scoped agent boots share a byte-identical common-core prefix (Story #4708)', () => {
  it('enumerates the role files', () => {
    assert.ok(
      roleFiles.length >= 2,
      'expected at least two role files under .agents/agents/',
    );
  });

  it('every role body carries exactly one role-delta marker', () => {
    for (const file of roleFiles) {
      const body = stripFrontmatter(
        readFileSync(path.join(AGENTS_DIR, file), 'utf8'),
        file,
      );
      const first = body.indexOf(ROLE_DELTA_MARKER);
      assert.ok(first !== -1, `${file} is missing the ${ROLE_DELTA_MARKER} marker`);
      assert.equal(
        body.indexOf(ROLE_DELTA_MARKER, first + 1),
        -1,
        `${file} carries more than one ${ROLE_DELTA_MARKER} marker`,
      );
    }
  });

  it('the shared core (everything before the marker) is byte-identical across all role files', () => {
    /** @type {Map<string, string>} file → shared-core prefix */
    const prefixes = new Map();
    for (const file of roleFiles) {
      const body = stripFrontmatter(
        readFileSync(path.join(AGENTS_DIR, file), 'utf8'),
        file,
      );
      const idx = body.indexOf(ROLE_DELTA_MARKER);
      const markerLineEnd = body.indexOf('\n', idx);
      assert.ok(markerLineEnd !== -1, `${file} marker line never ends`);
      prefixes.set(file, body.slice(0, markerLineEnd + 1));
    }
    const [refFile, refPrefix] = prefixes.entries().next().value;
    for (const [file, prefix] of prefixes) {
      assert.equal(
        prefix,
        refPrefix,
        `${file} shared core diverges from ${refFile} — the byte-identical prefix is what makes every role spawn cache-hit; edit the shared block in ALL role files at once`,
      );
    }
  });

  it('the shared core carries the @-imported security baseline ahead of any role content', () => {
    for (const file of roleFiles) {
      const body = stripFrontmatter(
        readFileSync(path.join(AGENTS_DIR, file), 'utf8'),
        file,
      );
      const idx = body.indexOf(ROLE_DELTA_MARKER);
      const shared = body.slice(0, idx);
      assert.match(
        shared,
        /^@\.\.\/\.\.\/\.agents\/rules\/security-baseline\.md$/m,
        `${file} shared core must @-import the security baseline`,
      );
    }
  });

  it('role-specific content (the role H1) sits strictly after the marker', () => {
    for (const file of roleFiles) {
      const body = stripFrontmatter(
        readFileSync(path.join(AGENTS_DIR, file), 'utf8'),
        file,
      );
      const idx = body.indexOf(ROLE_DELTA_MARKER);
      const shared = body.slice(0, idx);
      const delta = body.slice(idx);
      assert.doesNotMatch(
        shared,
        /^# /m,
        `${file} places an H1 (role content) inside the shared core — the role delta must come last`,
      );
      const roleName = file.replace(/\.md$/, '');
      assert.match(
        delta,
        new RegExp(`^# ${roleName} `, 'm'),
        `${file} role delta must open with the "# ${roleName} — …" heading after the marker`,
      );
      assert.ok(
        delta.trim().length > ROLE_DELTA_MARKER.length,
        `${file} has an empty role delta`,
      );
    }
  });
});
