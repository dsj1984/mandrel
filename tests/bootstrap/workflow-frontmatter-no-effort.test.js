/**
 * tests/bootstrap/workflow-frontmatter-no-effort.test.js — effort and model
 * pins live only on role agents (Story #5437).
 *
 * Changing effort mid-session invalidates the prompt cache for everything
 * after it. A workflow (slash command) runs inside the operator's session, so
 * a workflow that pinned its own `effort` or `model` would switch the session
 * mid-flight. Pins belong only on the role agents under `.agents/agents/`,
 * which boot on their own system prompt. This guard fails when any
 * `.agents/workflows/**` markdown frontmatter declares either key.
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const WORKFLOWS_DIR = path.join(REPO_ROOT, '.agents', 'workflows');

/** Keys that switch the session's effort or model when a command loads. */
const FORBIDDEN_KEYS = ['effort', 'model'];

/**
 * Return the YAML frontmatter block of a markdown file, or null when the file
 * opens without one.
 *
 * @param {string} content
 * @returns {string | null}
 */
function extractFrontmatter(content) {
  const text = content.replace(/\r\n/g, '\n');
  if (!text.startsWith('---\n')) return null;
  const end = text.indexOf('\n---', 4);
  return end === -1 ? null : text.slice(4, end);
}

/**
 * Top-level frontmatter keys from FORBIDDEN_KEYS that the block declares.
 *
 * @param {string | null} frontmatter
 * @returns {string[]}
 */
function forbiddenKeysIn(frontmatter) {
  if (frontmatter === null) return [];
  return FORBIDDEN_KEYS.filter((key) =>
    new RegExp(`^${key}\\s*:`, 'm').test(frontmatter),
  );
}

function listWorkflowFiles() {
  return readdirSync(WORKFLOWS_DIR, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) =>
      path.relative(REPO_ROOT, path.join(entry.parentPath, entry.name)),
    )
    .sort();
}

describe('workflow frontmatter pins no effort or model (Story #5437)', () => {
  it('detects a pinned effort or model in a frontmatter block', () => {
    assert.deepEqual(
      forbiddenKeysIn(extractFrontmatter('---\neffort: high\n---\n# x\n')),
      ['effort'],
    );
    assert.deepEqual(
      forbiddenKeysIn(
        extractFrontmatter('---\ndescription: d\nmodel: opus\n---\n'),
      ),
      ['model'],
    );
  });

  it('ignores the keys outside frontmatter and in files without one', () => {
    assert.deepEqual(
      forbiddenKeysIn(
        extractFrontmatter('---\ndescription: d\n---\neffort: high\n'),
      ),
      [],
    );
    assert.deepEqual(
      forbiddenKeysIn(extractFrontmatter('# no frontmatter\n')),
      [],
    );
  });

  it('finds workflow files to scan', () => {
    assert.ok(
      listWorkflowFiles().length > 0,
      'expected markdown workflows under .agents/workflows/',
    );
  });

  it('no workflow file declares effort or model in its frontmatter', () => {
    const offenders = listWorkflowFiles().flatMap((file) =>
      forbiddenKeysIn(
        extractFrontmatter(readFileSync(path.join(REPO_ROOT, file), 'utf8')),
      ).map((key) => `${file}: ${key}`),
    );
    assert.deepEqual(
      offenders,
      [],
      'effort and model pins belong only on role agents under .agents/agents/ — ' +
        'a workflow pin changes effort mid-session and invalidates the prompt cache',
    );
  });
});
