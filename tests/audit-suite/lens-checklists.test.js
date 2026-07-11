/**
 * Tests for the per-lens authoring-checklist generator (Story #4408).
 *
 * Covers the binding acceptance contract:
 *   - each checklist is distilled from its own `audit-<lens>.md` (named source),
 *     and a lens with no workflow yields no checklist and is reported;
 *   - the committed `.agents/audit-checklists/<lens>.md` files match a fresh
 *     generation (idempotent / drift-free) and are ≤ 40 lines each;
 *   - the `--check` drift gate flags an out-of-sync committed checklist;
 *   - the render is deterministic and hard-capped at 40 lines.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  buildExpected,
  CHECKLISTS_DIR,
  planChecklists,
  WORKFLOWS_DIR,
} from '../../.agents/scripts/generate-lens-checklists.js';
import {
  extractLensConcerns,
  MAX_CHECKLIST_LINES,
  renderLensChecklist,
  resolveDescription,
} from '../../.agents/scripts/lib/audit-suite/lens-checklist.js';
import { AUDIT_LENSES } from '../../.agents/scripts/lib/audit-to-stories/audit-lenses.js';

/** wc -l semantics: count of newline characters in the file. */
function newlineCount(text) {
  return (text.match(/\n/g) ?? []).length;
}

describe('lens checklist generation (committed artifacts)', () => {
  const { expected, missing, strays } = buildExpected();

  it('emits exactly one checklist per lens that has a workflow', () => {
    for (const lens of AUDIT_LENSES) {
      const hasWorkflow = fs.existsSync(
        path.join(WORKFLOWS_DIR, `audit-${lens}.md`),
      );
      assert.equal(
        expected.has(`${lens}.md`),
        hasWorkflow,
        `${lens}: checklist presence must track its audit-${lens}.md`,
      );
    }
  });

  it('reports lenses that have no audit-<lens>.md (no silent skip)', () => {
    // In-repo every canonical lens ships a workflow, so nothing is missing…
    assert.deepEqual(missing, []);
    // …and no stray checklist files linger under the directory.
    assert.deepEqual(strays, []);
  });

  it('every committed checklist matches a fresh generation (drift-free)', () => {
    for (const [basename, content] of expected) {
      const onDisk = fs.readFileSync(
        path.join(CHECKLISTS_DIR, basename),
        'utf8',
      );
      assert.equal(
        onDisk,
        content,
        `${basename} is stale — run node .agents/scripts/generate-lens-checklists.js`,
      );
    }
  });

  it('every committed checklist is 40 lines or fewer (wc -l)', () => {
    for (const basename of expected.keys()) {
      const text = fs.readFileSync(path.join(CHECKLISTS_DIR, basename), 'utf8');
      const lines = newlineCount(text);
      assert.ok(
        lines <= MAX_CHECKLIST_LINES,
        `${basename}: ${lines} lines exceeds the ${MAX_CHECKLIST_LINES}-line cap`,
      );
    }
  });

  it('names its own audit-<lens>.md as the distillation source', () => {
    for (const [basename, content] of expected) {
      const lens = basename.replace(/\.md$/, '');
      assert.match(
        content,
        new RegExp(`Source of truth: \\.agents/workflows/audit-${lens}\\.md`),
        `${basename} must name audit-${lens}.md as its source`,
      );
    }
  });
});

describe('planChecklists (missing-workflow reporting)', () => {
  it('records a lens with no workflow in missing and skips its checklist', () => {
    const { expected, missing } = planChecklists(
      ['security', 'ghost-lens'],
      (lens) => lens === 'security',
      () => '---\ndescription: x\n---\n\n# Security\n\n## Step 1: Scan\n',
    );
    assert.deepEqual(missing, ['ghost-lens']);
    assert.ok(expected.has('security.md'));
    assert.ok(!expected.has('ghost-lens.md'));
  });
});

describe('renderLensChecklist (pure)', () => {
  const sample = [
    '---',
    'description: A sample lens.',
    '---',
    '',
    '# Sample Audit',
    '',
    '## Role',
    '',
    '- **Not A Concern:** boilerplate under Role.',
    '',
    '## Step 2: Evaluation Dimensions',
    '',
    '1. **First Concern:** do the thing.',
    '2. **Second Concern:** do the other thing.',
    '',
    '## Step 3: Output Requirements',
    '',
    '- **Impact:** template field, must be excluded.',
    '',
    '# Sample Audit Report',
    '',
    '- **Severity:** also excluded.',
    '',
  ].join('\n');

  it('is deterministic for identical input', () => {
    assert.equal(
      renderLensChecklist('sample', sample),
      renderLensChecklist('sample', sample),
    );
  });

  it('lifts concerns and excludes boilerplate + report-template fields', () => {
    const out = renderLensChecklist('sample', sample);
    assert.match(out, /- \[ \] First Concern/);
    assert.match(out, /- \[ \] Second Concern/);
    assert.doesNotMatch(out, /Not A Concern/);
    assert.doesNotMatch(out, /Impact/);
    assert.doesNotMatch(out, /Severity/);
  });

  it('ends with a single trailing newline and stays within the cap', () => {
    const out = renderLensChecklist('sample', sample);
    assert.ok(out.endsWith('\n'));
    assert.ok(!out.endsWith('\n\n'));
    assert.ok(newlineCount(out) <= MAX_CHECKLIST_LINES);
  });

  it('falls back to step headings when a lens has no bold concerns', () => {
    const noConcerns = [
      '---',
      'description: y',
      '---',
      '',
      '# Bare Audit',
      '',
      '## Step 1: Inventory',
      '',
      'Prose only, no bold list items.',
      '',
      '## Step 2: Output Requirements',
      '',
    ].join('\n');
    const out = renderLensChecklist('bare', noConcerns);
    assert.match(out, /- \[ \] Inventory/);
  });

  it('truncates and marks overflow to honor the 40-line cap', () => {
    const many = Array.from(
      { length: 60 },
      (_, i) => `${i + 1}. **Concern ${i + 1}:** text.`,
    );
    const huge = [
      '---',
      'description: overflow lens.',
      '---',
      '',
      '# Huge Audit',
      '',
      '## Step 2: Analysis Dimensions',
      '',
      ...many,
      '',
      '## Step 3: Output Requirements',
      '',
    ].join('\n');
    const out = renderLensChecklist('huge', huge);
    assert.ok(
      newlineCount(out) <= MAX_CHECKLIST_LINES,
      'overflow output must still respect the cap',
    );
    assert.match(out, /see the full lens for the remaining concerns/);
  });
});

describe('extractLensConcerns / resolveDescription', () => {
  it('stops at the first report-template H1 or Output Requirements heading', () => {
    const { concerns } = extractLensConcerns(
      '# T\n\n## Step 1: X\n\n- **Keep:** yes.\n\n## Step 2: Output Requirements\n\n- **Drop:** no.\n',
    );
    assert.deepEqual(concerns, ['Keep']);
  });

  it('folds a YAML block-scalar description into one line', () => {
    const md = [
      '---',
      'description: >-',
      '  First folded line',
      '  and second folded line.',
      '---',
      '',
      '# T',
    ].join('\n');
    const desc = resolveDescription(md, { description: '>-' });
    assert.equal(desc, 'First folded line and second folded line.');
  });
});
