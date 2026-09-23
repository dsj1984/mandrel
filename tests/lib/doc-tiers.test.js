import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import {
  docsContextPaths,
  parseImportSpecifiers,
  resolveAlwaysLoadedClosure,
  resolveDocTiers,
  tierTotalBytes,
} from '../../.agents/scripts/lib/doc-tiers.js';
import { makeTempDir } from '../../.agents/scripts/lib/test-temp.js';

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
  const root = makeTempDir('doc-tiers-');
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

test('resolveAlwaysLoadedClosure falls back to AGENTS.md when CLAUDE.md is absent', () => {
  const root = makeRepo({ 'AGENTS.md': '@a.md\n', 'a.md': 'x\n' });
  const paths = resolveAlwaysLoadedClosure(root).map((e) => e.path);
  assert.deepEqual(paths, ['a.md', 'AGENTS.md']);
});

test('resolveAlwaysLoadedClosure uses CLAUDE.md alone when only it exists', () => {
  const root = makeRepo({ 'CLAUDE.md': '@a.md\n', 'a.md': 'x\n' });
  const paths = resolveAlwaysLoadedClosure(root).map((e) => e.path);
  assert.deepEqual(paths, ['a.md', 'CLAUDE.md']);
});

test('resolveAlwaysLoadedClosure prefers CLAUDE.md when both entry docs exist', () => {
  const root = makeRepo({
    'CLAUDE.md': '@a.md\n',
    'AGENTS.md': 'unread\n',
    'a.md': 'x\n',
  });
  const paths = resolveAlwaysLoadedClosure(root).map((e) => e.path);
  assert.deepEqual(paths, ['a.md', 'CLAUDE.md']);
});

test('resolveAlwaysLoadedClosure treats an AGENTS.md self-import as a cycle', () => {
  const root = makeRepo({ 'AGENTS.md': '@AGENTS.md\n' });
  const closure = resolveAlwaysLoadedClosure(root);
  assert.equal(closure.length, 1);
  assert.equal(closure[0].path, 'AGENTS.md');
});

test('resolveAlwaysLoadedClosure returns [] when neither entry doc exists', () => {
  const root = makeRepo({ 'README.md': 'x\n' });
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
    '.agents/rules/api-conventions.md': 'on-demand rule 2\n',
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
    ['.agents/rules/api-conventions.md', '.agents/rules/testing-standards.md'],
  );
  // Every entry carries { path, bytes }.
  for (const tier of Object.values(tiers)) {
    for (const e of tier) {
      assert.equal(typeof e.path, 'string');
      assert.equal(typeof e.bytes, 'number');
    }
  }
});

test('resolveDocTiers surfaces .agents/agents/*.md in the agentBoot tier', () => {
  const root = makeRepo({
    'CLAUDE.md': '@AGENTS.md\n',
    'AGENTS.md': 'onboarding\n',
    '.agents/agents/story-worker.md': 'boot A\n',
    '.agents/agents/retro.md': 'boot B\n',
  });
  const { tiers } = resolveDocTiers({ project: {} }, { root });
  assert.deepEqual(tiers.agentBoot.map((e) => e.path).sort(), [
    '.agents/agents/retro.md',
    '.agents/agents/story-worker.md',
  ]);
});

test('resolveDocTiers yields an empty agentBoot tier when the dir is absent', () => {
  const root = makeRepo({
    'CLAUDE.md': '@AGENTS.md\n',
    'AGENTS.md': 'onboarding\n',
  });
  const { tiers } = resolveDocTiers({ project: {} }, { root });
  assert.deepEqual(tiers.agentBoot, []);
});

test('resolveDocTiers adds the workflow tiers without double-counting any path (Story #4752)', () => {
  const root = makeRepo({
    'CLAUDE.md': '@AGENTS.md\n@.agents/rules/git-conventions.md\n',
    'AGENTS.md': 'onboarding\n',
    '.agents/rules/git-conventions.md': 'always-on rule\n',
    '.agents/rules/testing-standards.md': 'on-demand rule\n',
    '.agents/workflows/mandrel-deliver.md':
      '---\ndescription: fixture\nmandatoryReads: [helpers/digest.md]\n---\n\n# /mandrel-deliver\n\n[digest](helpers/digest.md) [appendix](helpers/appendix.md) [rule](../rules/testing-standards.md)\n',
    '.agents/workflows/helpers/digest.md': '# Digest\n',
    '.agents/workflows/helpers/appendix.md': '# Appendix\n',
  });
  const { tiers, workflowClosure } = resolveDocTiers({ project: {} }, { root });

  assert.deepEqual(
    tiers.workflow.map((e) => e.path),
    [
      '.agents/workflows/helpers/digest.md',
      '.agents/workflows/mandrel-deliver.md',
    ],
  );
  assert.deepEqual(
    tiers.workflowOnDemand.map((e) => e.path),
    ['.agents/workflows/helpers/appendix.md'],
  );
  // The rule the workflow links to stays in the on-demand *rules* tier — the
  // closure never re-counts an already-tiered flat set.
  assert.deepEqual(
    tiers.onDemand.map((e) => e.path),
    ['.agents/rules/testing-standards.md'],
  );

  // Every tier is disjoint: the union has no duplicate paths.
  const all = Object.values(tiers).flatMap((t) => t.map((e) => e.path));
  assert.equal(all.length, new Set(all).size);

  assert.equal(
    workflowClosure.mandatoryTotalBytes,
    tierTotalBytes(tiers.workflow),
  );
  assert.equal(
    workflowClosure.reachableTotalBytes,
    tierTotalBytes(tiers.workflow) + tierTotalBytes(tiers.workflowOnDemand),
  );
  assert.deepEqual(
    workflowClosure.entryPoints.map((e) => e.path),
    ['.agents/workflows/mandrel-deliver.md'],
  );
});

test('resolveDocTiers yields empty workflow tiers when the workflow tree is absent', () => {
  const root = makeRepo({ 'CLAUDE.md': '@AGENTS.md\n', 'AGENTS.md': 'x\n' });
  const { tiers, workflowClosure } = resolveDocTiers({ project: {} }, { root });
  assert.deepEqual(tiers.workflow, []);
  assert.deepEqual(tiers.workflowOnDemand, []);
  assert.deepEqual(workflowClosure.entryPoints, []);
  assert.equal(workflowClosure.reachableTotalBytes, 0);
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
