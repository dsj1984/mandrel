import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { renderWorkflowsDoc } from '../.agents/scripts/generate-workflows-doc.js';

/**
 * Tests for `generate-workflows-doc.js` — the catalog-backed generator that
 * renders the consumer-shipped `.agents/docs/workflows.md`.
 *
 * Covers: the pure render shape (header, command count, one table row per
 * entry, pipe escaping) and the drift gate (mutating a workflow description
 * makes `--check` exit non-zero; regenerating restores a clean check).
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
const DOC_PATH = path.join(REPO_ROOT, '.agents', 'docs', 'workflows.md');
const SAMPLE_WORKFLOW = path.join(
  REPO_ROOT,
  '.agents',
  'workflows',
  'epic-deliver.md',
);

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
  let savedDescriptionFile = null;

  afterEach(() => {
    if (savedDescriptionFile !== null) {
      fs.writeFileSync(SAMPLE_WORKFLOW, savedDescriptionFile, 'utf8');
      savedDescriptionFile = null;
    }
    // Always restore the generated doc to its on-disk-canonical form.
    execFileSync('node', [SCRIPT], { cwd: REPO_ROOT });
  });

  it('passes when the doc is in sync with the workflow set', () => {
    // Regenerate first so the precondition is clean regardless of test order.
    execFileSync('node', [SCRIPT], { cwd: REPO_ROOT });
    assert.doesNotThrow(() =>
      execFileSync('node', [SCRIPT, '--check'], { cwd: REPO_ROOT }),
    );
  });

  it('fails after a workflow description is mutated, then passes once regenerated', () => {
    execFileSync('node', [SCRIPT], { cwd: REPO_ROOT });

    // Mutate a real workflow's front-matter description.
    savedDescriptionFile = fs.readFileSync(SAMPLE_WORKFLOW, 'utf8');
    const mutated = savedDescriptionFile.replace(
      /^description:.*$/m,
      'description: A deliberately mutated description for the drift gate test.',
    );
    assert.notEqual(mutated, savedDescriptionFile, 'expected a real mutation');
    fs.writeFileSync(SAMPLE_WORKFLOW, mutated, 'utf8');

    // --check must now exit non-zero (stale doc vs mutated source).
    assert.throws(() =>
      execFileSync('node', [SCRIPT, '--check'], {
        cwd: REPO_ROOT,
        stdio: 'pipe',
      }),
    );

    // Regenerate against the mutated source — check is clean again.
    execFileSync('node', [SCRIPT], { cwd: REPO_ROOT });
    assert.doesNotThrow(() =>
      execFileSync('node', [SCRIPT, '--check'], { cwd: REPO_ROOT }),
    );
    assert.match(fs.readFileSync(DOC_PATH, 'utf8'), /deliberately mutated/);
  });
});
