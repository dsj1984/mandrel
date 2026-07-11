import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  docsContextPaths,
  parseImportSpecifiers,
  resolveAlwaysLoadedClosure,
  resolveDocTiers,
  tierTotalBytes,
} from '../../.agents/scripts/lib/doc-tiers.js';

/**
 * Unit coverage for the doc-tier resolver (Story #4438).
 *
 * Exercises the pure helpers directly, then drives `resolveDocTiers` end-to-end
 * against tmpdir fixtures — the always-loaded `@`-import closure (recursive,
 * cycle-safe, prose-`@` tolerant), the four-tier partition (highest tier wins),
 * and the empty-closure degradation.
 */

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

/**
 * Materialize a fixture repo under a fresh tmpdir. `files` maps repo-relative
 * paths to string contents. Returns the absolute root.
 */
function makeRepo(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-tiers-'));
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  }
  return root;
}

// ---------------------------------------------------------------------------
// parseImportSpecifiers
// ---------------------------------------------------------------------------

test('parseImportSpecifiers harvests line-start and inline @-imports', () => {
  const specs = parseImportSpecifiers(
    '# Title\n@AGENTS.md\n@.agents/instructions.md\nsome prose @.agentrc.json here\n',
  );
  assert.deepEqual(specs, [
    'AGENTS.md',
    '.agents/instructions.md',
    '.agentrc.json',
  ]);
});

test('parseImportSpecifiers ignores backtick-wrapped prose and trailing punctuation', () => {
  // "always-`@`-imported" must NOT match (the @ is backtick-preceded); a
  // trailing sentence period is trimmed off a real specifier.
  const specs = parseImportSpecifiers(
    'the always-`@`-imported file. See @notes.md. And nothing else',
  );
  assert.deepEqual(specs, ['notes.md']);
});

test('parseImportSpecifiers handles empty / nullish input', () => {
  assert.deepEqual(parseImportSpecifiers(''), []);
  assert.deepEqual(parseImportSpecifiers(undefined), []);
});

// ---------------------------------------------------------------------------
// resolveAlwaysLoadedClosure
// ---------------------------------------------------------------------------

test('resolveAlwaysLoadedClosure follows @-imports recursively and includes the entry', () => {
  const root = makeRepo({
    'CLAUDE.md': '@AGENTS.md\n@.agents/instructions.md\n',
    'AGENTS.md': 'onboarding only, no imports\n',
    '.agents/instructions.md': '@rules/security.md\n',
    '.agents/rules/security.md': 'security MUSTs\n',
  });
  const closure = resolveAlwaysLoadedClosure(root);
  const paths = closure.map((e) => e.path);
  assert.deepEqual(paths, [
    '.agents/instructions.md',
    '.agents/rules/security.md',
    'AGENTS.md',
    'CLAUDE.md',
  ]);
  for (const e of closure) assert.equal(typeof e.bytes, 'number');
});

test('resolveAlwaysLoadedClosure is cycle-safe', () => {
  const root = makeRepo({
    'CLAUDE.md': '@a.md\n',
    'a.md': '@b.md\n',
    'b.md': '@CLAUDE.md\n', // cycle back to the entry
  });
  const paths = resolveAlwaysLoadedClosure(root).map((e) => e.path);
  // Sorted by localeCompare (which orders 'CLAUDE.md' last); the point is that
  // the cycle back to the entry terminates with exactly three unique entries.
  assert.deepEqual(paths, ['a.md', 'b.md', 'CLAUDE.md']);
});

test('resolveAlwaysLoadedClosure drops @-tokens that do not resolve to a file', () => {
  const root = makeRepo({
    'CLAUDE.md': '@AGENTS.md\noperator @[USERNAME] noreply@example.com\n',
    'AGENTS.md': 'no imports\n',
  });
  const paths = resolveAlwaysLoadedClosure(root).map((e) => e.path);
  assert.deepEqual(paths, ['AGENTS.md', 'CLAUDE.md']);
});

test('resolveAlwaysLoadedClosure returns [] when CLAUDE.md is absent', () => {
  const root = makeRepo({ 'AGENTS.md': 'orphan\n' });
  assert.deepEqual(resolveAlwaysLoadedClosure(root), []);
});

// ---------------------------------------------------------------------------
// docsContextPaths
// ---------------------------------------------------------------------------

test('docsContextPaths prefixes docsContextFiles with docsRoot', () => {
  const config = {
    project: {
      paths: { docsRoot: 'docs' },
      docsContextFiles: ['architecture.md', 'patterns.md'],
    },
  };
  assert.deepEqual(docsContextPaths(config), [
    'docs/architecture.md',
    'docs/patterns.md',
  ]);
});

test('docsContextPaths returns [] when unconfigured', () => {
  assert.deepEqual(docsContextPaths({ project: {} }), []);
});

// ---------------------------------------------------------------------------
// resolveDocTiers — four-tier partition
// ---------------------------------------------------------------------------

test('resolveDocTiers partitions the four tiers with highest-tier-wins dedup', () => {
  const root = makeRepo({
    'CLAUDE.md':
      '@AGENTS.md\n@.agents/rules/security-baseline.md\n@.agents/rules/git-conventions.md\n',
    'AGENTS.md': 'onboarding\n',
    '.agents/rules/security-baseline.md': 'always-on rule A\n',
    '.agents/rules/git-conventions.md': 'always-on rule B\n',
    '.agents/rules/testing-standards.md': 'on-demand rule\n',
    '.agents/rules/shell-conventions.md': 'on-demand rule 2\n',
    'docs/architecture.md': 'context doc\n',
    'docs/style-guide.md': 'conditional doc\n',
  });
  const config = {
    project: {
      paths: { docsRoot: 'docs' },
      docsContextFiles: ['architecture.md'],
    },
  };
  const { tiers } = resolveDocTiers(config, { root });

  assert.deepEqual(tiers.alwaysLoaded.map((e) => e.path).sort(), [
    '.agents/rules/git-conventions.md',
    '.agents/rules/security-baseline.md',
    'AGENTS.md',
    'CLAUDE.md',
  ]);
  assert.deepEqual(
    tiers.mandatoryRead.map((e) => e.path),
    ['docs/architecture.md'],
  );
  assert.deepEqual(
    tiers.digestVisible.map((e) => e.path),
    ['docs/style-guide.md'],
  );
  // The always-on rules stay in alwaysLoaded, NOT onDemand.
  assert.deepEqual(
    tiers.onDemand.map((e) => e.path),
    [
      '.agents/rules/shell-conventions.md',
      '.agents/rules/testing-standards.md',
    ],
  );
  // Every entry carries { path, bytes }.
  for (const tier of Object.values(tiers)) {
    for (const e of tier) {
      assert.equal(typeof e.path, 'string');
      assert.equal(typeof e.bytes, 'number');
    }
  }
});

test('resolveDocTiers skips absent context / conditional docs silently', () => {
  const root = makeRepo({
    'CLAUDE.md': '@AGENTS.md\n',
    'AGENTS.md': 'onboarding\n',
  });
  const config = {
    project: {
      paths: { docsRoot: 'docs' },
      docsContextFiles: ['architecture.md'], // file absent
    },
  };
  const { tiers } = resolveDocTiers(config, { root });
  assert.deepEqual(tiers.mandatoryRead, []);
  assert.deepEqual(tiers.digestVisible, []);
});

// ---------------------------------------------------------------------------
// tierTotalBytes
// ---------------------------------------------------------------------------

test('tierTotalBytes sums entry bytes and tolerates nullish', () => {
  assert.equal(tierTotalBytes([{ bytes: 10 }, { bytes: 5 }]), 15);
  assert.equal(tierTotalBytes([]), 0);
  assert.equal(tierTotalBytes(undefined), 0);
});
