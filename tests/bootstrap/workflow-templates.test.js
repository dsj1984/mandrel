/**
 * bootstrap/workflow-templates — Epic #1235 Story 5
 *
 * Covers:
 *   - Fresh repo: missing target files are copied, no HITL.
 *   - Identical content: no-op (unchanged).
 *   - Drift + HITL decline: target left untouched.
 *   - Drift + HITL approve: target overwritten.
 *
 * Uses a temp template root + temp target root so the test never touches
 * the framework's real template files or its real `.github/workflows/`.
 */

import assert from 'node:assert/strict';
import { promises as fs, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { copyWorkflowTemplates } from '../../.agents/scripts/lib/bootstrap/workflow-templates.js';

let scratch;
let templateRoot;
let targetRoot;

async function writeFile(root, rel, body) {
  const p = path.join(root, rel);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, body, 'utf8');
  return p;
}

async function seedTemplates() {
  // Mirror the actual template manifest with stub content so the test
  // does not depend on the framework's real template payload.
  const manifest = [
    'workflows/triage-pr-failure.yml',
    'workflows/auto-fix.yml',
    'scripts/triage-ci-failure.js',
    'scripts/auto-fix-step.js',
    'scripts/auto-fix-bail.js',
    'scripts/lib/triage/parse-crap-report.js',
    'scripts/lib/triage/parse-test-output.js',
    'scripts/lib/triage/render-comment.js',
    'scripts/lib/auto-fix/detect-failure-class.js',
  ];
  for (const rel of manifest) {
    await writeFile(templateRoot, rel, `// framework v1: ${rel}\n`);
  }
}

beforeEach(async () => {
  scratch = mkdtempSync(path.join(tmpdir(), 'bs-wf-'));
  templateRoot = path.join(scratch, 'templates');
  targetRoot = path.join(scratch, 'consumer');
  await fs.mkdir(templateRoot, { recursive: true });
  await fs.mkdir(targetRoot, { recursive: true });
  await seedTemplates();
});

afterEach(async () => {
  await fs.rm(scratch, { recursive: true, force: true });
});

describe('bootstrap/copyWorkflowTemplates', () => {
  it('fresh repo: copies every template, no HITL invocation', async () => {
    let hitl = 0;
    const summary = await copyWorkflowTemplates({
      targetRoot,
      templateRoot,
      hitlConfirm: async () => {
        hitl++;
        return true;
      },
    });
    assert.equal(hitl, 0);
    assert.equal(summary.copied.length, 9);
    assert.equal(summary.unchanged.length, 0);
    assert.equal(summary.drifted.length, 0);
    // Spot-check one workflow + one script landed at the expected path.
    const wf = await fs.readFile(
      path.join(targetRoot, '.github/workflows/triage-pr-failure.yml'),
      'utf8',
    );
    assert.match(wf, /framework v1/);
    const sc = await fs.readFile(
      path.join(
        targetRoot,
        '.agents/scripts/lib/auto-fix/detect-failure-class.js',
      ),
      'utf8',
    );
    assert.match(sc, /framework v1/);
  });

  it('identical content: no-op (all unchanged)', async () => {
    // First copy.
    await copyWorkflowTemplates({ targetRoot, templateRoot });
    // Second run: every file already byte-identical.
    let hitl = 0;
    const summary = await copyWorkflowTemplates({
      targetRoot,
      templateRoot,
      hitlConfirm: async () => {
        hitl++;
        return true;
      },
    });
    assert.equal(hitl, 0);
    assert.equal(summary.copied.length, 0);
    assert.equal(summary.unchanged.length, 9);
    assert.equal(summary.drifted.length, 0);
  });

  it('drift + HITL decline: target left untouched', async () => {
    await copyWorkflowTemplates({ targetRoot, templateRoot });
    // Operator edits one file out from under us.
    const driftedRel = '.github/workflows/auto-fix.yml';
    const driftedAbs = path.join(targetRoot, driftedRel);
    const operatorBody = '# operator edit — keep this\n';
    await fs.writeFile(driftedAbs, operatorBody, 'utf8');

    const summary = await copyWorkflowTemplates({
      targetRoot,
      templateRoot,
      hitlConfirm: async () => false,
    });
    assert.deepEqual(summary.drifted, [driftedRel]);
    const stillThere = await fs.readFile(driftedAbs, 'utf8');
    assert.equal(stillThere, operatorBody);
  });

  it('drift + HITL approve: target overwritten with framework source', async () => {
    await copyWorkflowTemplates({ targetRoot, templateRoot });
    const driftedRel = '.github/workflows/triage-pr-failure.yml';
    const driftedAbs = path.join(targetRoot, driftedRel);
    await fs.writeFile(driftedAbs, '# stale\n', 'utf8');

    const summary = await copyWorkflowTemplates({
      targetRoot,
      templateRoot,
      hitlConfirm: async () => true,
    });
    assert.ok(summary.copied.includes(driftedRel));
    const body = await fs.readFile(driftedAbs, 'utf8');
    assert.match(body, /framework v1/);
  });

  it('non-TTY default (no hitlConfirm) leaves drifted files alone', async () => {
    await copyWorkflowTemplates({ targetRoot, templateRoot });
    const driftedRel = '.agents/scripts/triage-ci-failure.js';
    const driftedAbs = path.join(targetRoot, driftedRel);
    await fs.writeFile(driftedAbs, '// operator override\n', 'utf8');

    const summary = await copyWorkflowTemplates({ targetRoot, templateRoot });
    assert.ok(summary.drifted.includes(driftedRel));
    const body = await fs.readFile(driftedAbs, 'utf8');
    assert.equal(body, '// operator override\n');
  });

  it('throws when targetRoot is missing', async () => {
    await assert.rejects(
      () => copyWorkflowTemplates({ templateRoot, targetRoot: undefined }),
      /targetRoot is required/,
    );
  });
});
