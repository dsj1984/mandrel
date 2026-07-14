// tests/bootstrap/issue-forms-template.test.js
/**
 * Unit tests for the generated GitHub Issue Forms (Story #4227).
 *
 * Covers the acceptance criteria:
 *   - forms are generated from the body SSOT (field set ⊆ schema, headings
 *     match the parser's section names)
 *   - a form-filled body round-trips through story-body.parse()
 *   - forms auto-apply the correct type:: + entry-state labels
 *   - machine-managed sections are absent from the human form
 *   - ensureIssueForms is idempotent and preserves operator edits
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
  assembleBodyFromFormValues,
  CONFORMANCE_WORKFLOW_RELATIVE_PATH,
  ensureIssueForms,
  HUMAN_INTENT_FIELDS,
  renderIssueForm,
  STORY_FORM_RELATIVE_PATH,
} from '../../.agents/scripts/lib/bootstrap/issue-forms-template.js';
import { parse } from '../../.agents/scripts/lib/story-body/story-body.js';

describe('renderIssueForm — field set and labels', () => {
  it('exposes only the human intent subset (no machine-managed fields)', () => {
    const ids = HUMAN_INTENT_FIELDS.map((f) => f.id);
    assert.deepEqual(ids, [
      'goal',
      'changes',
      'acceptance',
      'verify',
      'references',
    ]);
    // Machine-managed body fields must NOT be form fields.
    for (const forbidden of [
      'wide',
      'reason_to_exist',
      'estimated_test_files',
    ]) {
      assert.ok(!ids.includes(forbidden), `${forbidden} must be absent`);
    }
  });

  it('auto-applies the type::story + entry-state labels on the story form', () => {
    const yaml = renderIssueForm('story');
    assert.match(yaml, /^ {2}- type::story$/m);
    assert.match(yaml, /^ {2}- agent::review-spec$/m);
    assert.match(yaml, /^name: Story$/m);
  });

  it('honours a custom entry-state label', () => {
    const yaml = renderIssueForm('story', { entryStateLabel: 'agent::ready' });
    assert.match(yaml, /^ {2}- agent::ready$/m);
  });

  it('does not leak the machine-managed meta block into the form', () => {
    const yaml = renderIssueForm('story');
    assert.ok(!yaml.includes('<!-- meta:'));
  });

  it('throws on an unknown ticket type', () => {
    assert.throws(() => renderIssueForm('feature'), /must be 'story'/);
  });
});

describe('assembleBodyFromFormValues — round-trips through parse()', () => {
  it('produces a body parse() accepts with all required sections', () => {
    const body = assembleBodyFromFormValues({
      goal: 'Generate issue forms from the body SSOT.',
      changes: '- .agents/scripts/lib/bootstrap/issue-forms-template.js: add',
      acceptance: '- forms round-trip through parse()\n- labels auto-apply',
      verify:
        '- npm test -- tests/bootstrap/issue-forms-template.test.js (unit)',
      references: '- docs/architecture.md',
      depends_on: '#4226, 4225',
    });

    const { body: parsed, info } = parse(body);
    assert.equal(info.isLegacyStringBody, false);
    assert.equal(parsed.goal, 'Generate issue forms from the body SSOT.');
    assert.equal(parsed.acceptance.length, 2);
    assert.equal(parsed.verify.length, 1);
    assert.equal(parsed.changes.length, 1);
    // depends_on normalizes bare and #-prefixed refs to #N footer lines.
    assert.deepEqual(parsed.depends_on, ['#4226', '#4225']);
  });

  it('omits empty optional sections', () => {
    const body = assembleBodyFromFormValues({
      goal: 'Minimal goal.',
      acceptance: '- it works',
      verify: '- npm test (unit)',
    });
    assert.ok(!body.includes('## Changes'));
    assert.ok(!body.includes('## References'));
    const { body: parsed } = parse(body);
    assert.equal(parsed.changes.length, 0);
  });

  it('round-trips a GitHub-style level-3 heading body through parse()', () => {
    // GitHub Issue Forms render field labels as `### Label`, not `##`.
    const githubStyleBody = [
      '### Goal',
      '',
      'Ship the forms.',
      '',
      '### Acceptance',
      '',
      '- the form parses',
      '',
      '### Verify',
      '',
      '- npm test (unit)',
    ].join('\n');
    const { body: parsed, info } = parse(githubStyleBody);
    assert.equal(info.isLegacyStringBody, false);
    assert.equal(parsed.goal, 'Ship the forms.');
    assert.equal(parsed.acceptance.length, 1);
    assert.equal(parsed.verify.length, 1);
  });
});

describe('ensureIssueForms — materialization', () => {
  let tmpRoot;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-forms-'));
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('creates the story form + the conformance workflow, then is idempotent', () => {
    const first = ensureIssueForms({ projectRoot: tmpRoot });
    const byType = Object.fromEntries(first.forms.map((f) => [f.type, f]));
    assert.equal(byType.story.action, 'created');
    assert.equal(byType['conformance-workflow'].action, 'created');
    assert.ok(fs.existsSync(path.join(tmpRoot, STORY_FORM_RELATIVE_PATH)));
    assert.ok(
      fs.existsSync(path.join(tmpRoot, CONFORMANCE_WORKFLOW_RELATIVE_PATH)),
    );

    const second = ensureIssueForms({ projectRoot: tmpRoot });
    for (const form of second.forms) {
      assert.equal(form.action, 'unchanged');
    }
  });

  it('preserves an operator-edited form as custom-skip', () => {
    const target = path.join(tmpRoot, STORY_FORM_RELATIVE_PATH);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, '# operator-authored form\n', 'utf8');

    const result = ensureIssueForms({ projectRoot: tmpRoot });
    const story = result.forms.find((f) => f.type === 'story');
    assert.equal(story.action, 'custom-skip');
    assert.equal(fs.readFileSync(target, 'utf8'), '# operator-authored form\n');
    assert.ok(story.rendered.includes('name: Story'));
  });

  it('write:false computes actions without touching disk', () => {
    const result = ensureIssueForms({ projectRoot: tmpRoot, write: false });
    assert.equal(result.forms[0].action, 'created');
    assert.ok(!fs.existsSync(path.join(tmpRoot, STORY_FORM_RELATIVE_PATH)));
  });
});
