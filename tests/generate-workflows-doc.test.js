import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { renderWorkflowsDoc } from '../.agents/scripts/generate-workflows-doc.js';
import { makeTempDir } from '../.agents/scripts/lib/test-temp.js';

/**
 * Tests for `generate-workflows-doc.js` — the catalog-backed generator that
 * renders the consumer-shipped `.agents/docs/workflows.md`.
 *
 * Covers: the pure render shape (header, command count, one table row per
 * entry, pipe escaping) and the drift gate (mutating a workflow description
 * makes `--check` exit non-zero; regenerating restores a clean check).
 *
 * ## Why the drift gate runs against a fixture root
 *
 * The drift gate can only be proved by making a workflow description drift,
 * and this file used to do that to the **real**
 * `.agents/workflows/mandrel-deliver.md`, restoring it in `afterEach`. The
 * proof was sound; the blast radius was not. `node --test` runs test files
 * concurrently against one shared checkout, so while that edit stood, every
 * other test file in the run saw a dirty tree —
 * `tests/enforcement/workflow-script-help.test.js` ends on a repo-wide
 * `git status --porcelain` and reported the collision as "`--help` mutated
 * the working tree", naming `.agents/workflows/mandrel-deliver.md`. It went
 * red on the Windows Smoke job, where each `node` spawn between the mutation
 * and its restore costs enough to stretch a ~130 ms window on Linux into
 * roughly a second, and stayed green on ubuntu — the signature of a race,
 * not of a script that writes on `--help`.
 *
 * `--root` lets the same proof run inside a tmpdir. The guard below keeps it
 * there.
 */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.join(
  REPO_ROOT,
  '.agents',
  'scripts',
  'generate-workflows-doc.js',
);

/**
 * The two real paths the pre-fixture version of this suite wrote to. Read
 * before and after the drift-gate run so a future edit that re-points the
 * suite at the live checkout fails here rather than surfacing as an
 * unrelated test file's phantom dirty-tree failure.
 */
const REAL_TREE_WITNESSES = [
  path.join(REPO_ROOT, '.agents', 'workflows', 'mandrel-deliver.md'),
  path.join(REPO_ROOT, '.agents', 'docs', 'workflows.md'),
];

describe('renderWorkflowsDoc', () => {
  it('renders the generated header, command count, and one row per entry', () => {
    const out = renderWorkflowsDoc([
      { name: 'alpha', description: 'First workflow entry', vague: false },
      { name: 'beta', description: null, vague: true },
    ]);
    assert.match(out, /GENERATED FILE — do not edit by hand/);
    assert.match(out, /# Workflow \(Slash-Command\) Reference Index/);
    assert.match(out, /## Commands \(2\)/);
    assert.match(out, /\| `\/alpha` \| First workflow entry \|/);
    assert.match(out, /\| `\/beta` \| _\(no description\)_ \|/);
  });

  it('escapes pipe characters so a description cannot break the table', () => {
    const out = renderWorkflowsDoc([
      { name: 'piped', description: 'has a | pipe inside', vague: false },
    ]);
    assert.match(out, /\| `\/piped` \| has a \\\| pipe inside \|/);
  });
});

describe('generate-workflows-doc --check drift gate', () => {
  /** @type {string} */
  let root;
  /** @type {string} */
  let sampleWorkflow;
  /** @type {string} */
  let docPath;
  /** @type {Map<string, Buffer>} */
  const realTreeBefore = new Map();

  const run = (...args) =>
    execFileSync('node', [SCRIPT, '--root', root, ...args], {
      cwd: REPO_ROOT,
      stdio: 'pipe',
    });

  before(() => {
    for (const witness of REAL_TREE_WITNESSES) {
      realTreeBefore.set(witness, fs.readFileSync(witness));
    }
    root = makeTempDir('generate-workflows-doc-');
    const workflows = path.join(root, '.agents', 'workflows');
    fs.mkdirSync(path.join(workflows, 'loops'), { recursive: true });
    sampleWorkflow = path.join(workflows, 'sample-deliver.md');
    docPath = path.join(root, '.agents', 'docs', 'workflows.md');
    fs.writeFileSync(
      sampleWorkflow,
      '---\ndescription: Land a planned Story on its own branch and open the PR.\n---\n\n# /sample-deliver\n',
      'utf8',
    );
    fs.writeFileSync(
      path.join(workflows, 'sample-plan.md'),
      '---\ndescription: Interrogate the request, author the Story, persist it.\n---\n\n# /sample-plan\n',
      'utf8',
    );
    fs.writeFileSync(
      path.join(workflows, 'loops', 'sample-loop.md'),
      '---\ndescription: Poll the open pull requests until every check reports.\n---\n\n# /loops:sample-loop\n',
      'utf8',
    );
  });

  it('refuses a doc that does not exist yet, then passes once generated', () => {
    assert.throws(() => run('--check'));
    run();
    const doc = fs.readFileSync(docPath, 'utf8');
    assert.match(doc, /## Commands \(2\)/);
    assert.match(doc, /\| `\/sample-deliver` \|/);
    assert.match(doc, /\| `\/loops:sample-loop` \|/);
    assert.doesNotThrow(() => run('--check'));
  });

  it('fails after a workflow description is mutated, then passes once regenerated', () => {
    run();
    assert.doesNotThrow(() => run('--check'));

    const original = fs.readFileSync(sampleWorkflow, 'utf8');
    const mutated = original.replace(
      /^description:.*$/m,
      'description: A deliberately mutated description for the drift gate test.',
    );
    assert.notEqual(mutated, original, 'expected a real mutation');
    fs.writeFileSync(sampleWorkflow, mutated, 'utf8');

    // --check must now exit non-zero (stale doc vs mutated source).
    assert.throws(() => run('--check'));

    // Regenerate against the mutated source — check is clean again.
    run();
    assert.doesNotThrow(() => run('--check'));
    assert.match(fs.readFileSync(docPath, 'utf8'), /deliberately mutated/);
  });

  it('leaves the real checkout byte-identical (Windows Smoke race, CI 34523840460)', () => {
    for (const [witness, before_] of realTreeBefore) {
      assert.ok(
        fs.readFileSync(witness).equals(before_),
        `${path.relative(REPO_ROOT, witness)} was rewritten by this suite. The ` +
          'drift gate must be proved against a `--root` fixture: `node --test` ' +
          'shares one checkout across concurrent test files, so a mutation here ' +
          'surfaces as a dirty-tree failure in whichever unrelated file happens ' +
          'to run `git status` inside the window.',
      );
    }
  });

  after(() => {
    // The generator is the only writer under `root`, and `makeTempDir`
    // registers its own reaping — nothing to restore.
    assert.ok(fs.existsSync(docPath), 'fixture doc should have been written');
  });
});
