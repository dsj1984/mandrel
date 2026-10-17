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
 * The sync headers injected into materialized `.claude/agents/` /
 * `.claude/commands/` copies are checked too, through the projectors' own
 * output — a header that grew a timestamp would poison every materialized
 * boot prompt at byte 0.
 */

import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { expectedClaudeAgents } from '../../.agents/scripts/lib/claude/agents-projection.js';
import { expectedClaudeCommands } from '../../.agents/scripts/lib/claude/commands-projection.js';
import { makeTempDir } from '../../.agents/scripts/lib/test-temp.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

/** The files that make up the always-on @-closure a session boots on. */
const CLOSURE_FILES = [
  'AGENTS.md',
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
    // A static body from both sources: any volatile byte is the header's.
    const root = makeTempDir('prefix-stability-');
    const src = (zone) => {
      const dir = path.join(root, zone);
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, `${zone}.md`), '# static body\n');
      return dir;
    };
    const sources = { payloadSrc: src('payload'), localSrc: src('local') };
    const projected = [
      ...expectedClaudeAgents({
        projectRoot: root,
        ...sources,
        agentModels: {},
      }),
      ...expectedClaudeCommands({ projectRoot: root, ...sources }),
    ];
    assert.equal(projected.length, 4);
    for (const [name, body] of projected) {
      assertStable(`projected ${name}`, body);
    }
  });
});
