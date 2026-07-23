/**
 * tests/bootstrap/prefix-stability.test.js — no volatile bytes ahead of the
 * stable closure (Story #4708, AC-6).
 *
 * Prompt-cache is keyed on the exact byte prefix of the assembled context:
 * one early dynamic byte (a timestamp, a run id, a generated-at banner)
 * invalidates the cache for everything after it, every turn, in every
 * session. The always-on closure files and the role-scoped boot contexts
 * must therefore contain no volatile content at all — asserted over the
 * whole file, which is strictly stronger than "ahead of stable bytes" and
 * has no false positives on this corpus.
 *
 * The sync header injected into materialized `.claude/agents/` /
 * `.claude/commands/` copies is imported and checked too — a header that
 * grew a timestamp would poison every materialized boot prompt at byte 0.
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  HEADER as AGENTS_HEADER,
  LOCAL_HEADER as AGENTS_LOCAL_HEADER,
} from '../../.agents/scripts/sync-claude-agents.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

/** The files that make up the always-on @-closure a session boots on. */
const CLOSURE_FILES = [
  'CLAUDE.md',
  'AGENTS.md',
  '.agentrc.json',
  '.agents/instructions.md',
  '.agents/rules/security-baseline.md',
  '.agents/rules/git-conventions.md',
];

/**
 * Volatile-content signatures. Each entry names the class so a failure
 * message says what leaked, not just where.
 */
const VOLATILE_PATTERNS = [
  { name: 'ISO datetime', re: /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/ },
  { name: 'generated-at banner', re: /generated (?:at|on)[:\s]+\d/i },
  { name: 'generatedAt field', re: /"generatedAt"/ },
  { name: 'run id', re: /\brun-[0-9a-f]{8,}\b/ },
  {
    name: 'unexpanded template placeholder',
    re: /\{\{\s*(?:timestamp|date|time|runId|buildId)\s*\}\}/i,
  },
];

function assertStable(label, content) {
  for (const { name, re } of VOLATILE_PATTERNS) {
    const m = content.match(re);
    assert.equal(
      m,
      null,
      `${label} contains volatile content (${name}: ${JSON.stringify(m?.[0])}) — one dynamic byte ahead of the stable closure invalidates the prompt cache for everything after it`,
    );
  }
}

describe('prefix stability — the assembled closure carries no volatile bytes (Story #4708, AC-6)', () => {
  for (const file of CLOSURE_FILES) {
    it(`${file} is volatile-free`, () => {
      assertStable(file, readFileSync(path.join(REPO_ROOT, file), 'utf8'));
    });
  }

  it('every role-scoped boot context is volatile-free', () => {
    const agentsDir = path.join(REPO_ROOT, '.agents', 'agents');
    for (const file of readdirSync(agentsDir).filter((f) =>
      f.endsWith('.md'),
    )) {
      assertStable(
        `.agents/agents/${file}`,
        readFileSync(path.join(agentsDir, file), 'utf8'),
      );
    }
  });

  it('the sync-injected materialization headers are static', () => {
    assertStable('sync-claude-agents.js HEADER', AGENTS_HEADER);
    assertStable('sync-claude-agents.js LOCAL_HEADER', AGENTS_LOCAL_HEADER);
  });
});
