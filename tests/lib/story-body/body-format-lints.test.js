/**
 * body-format-lints — the deterministic body-format lint registry, the
 * mechanical auto-fix helpers, and their two contracts (Story #4684):
 *   AC-1: every enumerated rejecting lint has an example-carrying instruction
 *         in the story-author (decomposer) system prompt.
 *   AC-2: the mechanical rewrites (Changes bullet shape, inferable verify tier)
 *         surface the corrected form in the failing dry-run/validation output.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { validateTaskBodyShape } from '../../../.agents/scripts/lib/orchestration/task-body-validator.js';
import {
  BODY_FORMAT_LINTS,
  suggestPathEntryFix,
} from '../../../.agents/scripts/lib/story-body/body-format-lints.js';
import {
  parse,
  StoryBodyParseError,
} from '../../../.agents/scripts/lib/story-body/story-body.js';
import { renderStoryAuthorCore } from '../../../.agents/scripts/lib/templates/decomposer-prompts.js';

describe('BODY_FORMAT_LINTS registry', () => {
  it('is non-empty and each entry is fully specified', () => {
    assert.ok(BODY_FORMAT_LINTS.length >= 5);
    for (const lint of BODY_FORMAT_LINTS) {
      for (const field of ['id', 'summary', 'badExample', 'goodExample']) {
        assert.equal(
          typeof lint[field],
          'string',
          `lint ${lint.id} missing ${field}`,
        );
        assert.ok(
          lint[field].trim().length > 0,
          `lint ${lint.id}.${field} empty`,
        );
      }
      assert.equal(typeof lint.autoFixable, 'boolean');
    }
  });

  it('covers the known rejecting lints, with the one auto-fixable one (Story #5312)', () => {
    const ids = new Set(BODY_FORMAT_LINTS.map((l) => l.id));
    for (const required of [
      'changes-path-entry-shape',
      'verify-non-empty',
      'acceptance-non-empty',
    ]) {
      assert.ok(ids.has(required), `registry is missing lint "${required}"`);
    }
    for (const retired of ['verify-tier-suffix', 'verify-manual-reason']) {
      assert.ok(!ids.has(retired), `retired lint "${retired}" must be gone`);
    }
    const autoFixable = BODY_FORMAT_LINTS.filter((l) => l.autoFixable).map(
      (l) => l.id,
    );
    assert.deepEqual(autoFixable, ['changes-path-entry-shape']);
  });
});

describe('AC-1: every rejecting lint is stated example-first in the author prompt', () => {
  const prompt = renderStoryAuthorCore();

  it('names each lint id and renders each good example verbatim', () => {
    for (const lint of BODY_FORMAT_LINTS) {
      assert.ok(
        prompt.includes(lint.id),
        `prompt does not name lint "${lint.id}"`,
      );
      assert.ok(
        prompt.includes(lint.goodExample),
        `prompt does not carry the example for lint "${lint.id}"`,
      );
    }
  });

  it('renders the checklist bullet for each lint into the prompt', () => {
    for (const lint of BODY_FORMAT_LINTS) {
      assert.ok(
        prompt.includes(`**${lint.id}** — ${lint.summary}`),
        `prompt is missing the checklist bullet for "${lint.id}"`,
      );
    }
  });
});

describe('AC-2: suggestPathEntryFix', () => {
  it('proposes a paste-ready { path, assumption } object that round-trips', () => {
    const fix = suggestPathEntryFix('- src/app.js');
    assert.equal(
      fix,
      '{"path":"src/app.js","assumption":"refactors-existing"}',
    );
    // Round-trip: the suggestion parses cleanly back through the story body.
    const body = [
      '## Goal',
      'G',
      '',
      '## Changes',
      `- ${fix}`,
      '',
      '## Acceptance',
      '- [ ] x',
      '',
      '## Verify',
      '- npm run validate (validate)',
    ].join('\n');
    const { body: parsed } = parse(body);
    assert.deepEqual(parsed.changes, [
      { path: 'src/app.js', assumption: 'refactors-existing' },
    ]);
  });

  it('salvages the path from a humanized bullet with a bad assumption', () => {
    assert.equal(
      suggestPathEntryFix('`src/app.js` — modified'),
      '{"path":"src/app.js","assumption":"refactors-existing"}',
    );
  });

  it('returns null when there is no path-shaped token', () => {
    assert.equal(suggestPathEntryFix('clean up the code'), null);
    assert.equal(suggestPathEntryFix(''), null);
  });
});

describe('AC-2: the failing lint output carries the corrected form', () => {
  it('story-body parser rejects a bare Changes bullet WITH a suggested fix', () => {
    const body = [
      '## Goal',
      'G',
      '',
      '## Changes',
      '- src/app.js',
      '',
      '## Acceptance',
      '- [ ] x',
      '',
      '## Verify',
      '- npm run validate (validate)',
    ].join('\n');
    assert.throws(
      () => parse(body),
      (err) => {
        assert.ok(err instanceof StoryBodyParseError);
        assert.match(err.message, /Suggested fix:/);
        assert.match(err.message, /"path":"src\/app\.js"/);
        assert.match(err.message, /"assumption":"refactors-existing"/);
        return true;
      },
    );
  });

  it('validator rejects a string Changes bullet WITH a suggested fix', () => {
    const errors = validateTaskBodyShape({
      type: 'story',
      slug: 'demo',
      title: 'Demo',
      body: {
        goal: 'G',
        changes: ['src/app.js'],
        acceptance: ['x'],
        verify: ['npm run validate (validate)'],
      },
    });
    const changesError = errors.find((e) => e.includes('body.changes entry'));
    assert.ok(
      changesError,
      `expected a changes error, got: ${errors.join('\n')}`,
    );
    assert.match(changesError, /Suggested fix: \{"path":"src\/app\.js"/);
  });
});
