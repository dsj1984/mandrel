// tests/scripts/lint-issue-body.test.js
/**
 * Unit tests for the issue-body conformance lint evaluator (Story #4227).
 *
 * Covers the pure `evaluateIssueBody` core and `renderConformanceComment`.
 * The GitHub-touching CLI wrapper is intentionally not exercised here (no
 * live `gh`); the evaluator is the drift-guard logic.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  evaluateIssueBody,
  isStoryTicket,
  LINT_COMMENT_MARKER,
  renderConformanceComment,
  runLintIssueBody,
} from '../../.agents/scripts/lint-issue-body.js';

describe('evaluateIssueBody — conformant bodies', () => {
  it('passes a well-formed canonical body', () => {
    const body = [
      '## Goal',
      'Do the thing.',
      '',
      '## Acceptance',
      '- [ ] it works',
      '',
      '## Verify',
      '- npm test (unit)',
    ].join('\n');
    const verdict = evaluateIssueBody(body);
    assert.equal(verdict.conformant, true);
    assert.deepEqual(verdict.problems, []);
    assert.equal(verdict.parseFailed, false);
  });

  it('passes a GitHub-form (level-3 heading) body', () => {
    const body = [
      '### Goal',
      '',
      'Ship it.',
      '',
      '### Acceptance',
      '',
      '- done when green',
      '',
      '### Verify',
      '',
      '- npm test (unit)',
    ].join('\n');
    const verdict = evaluateIssueBody(body);
    assert.equal(verdict.conformant, true);
  });

  it('treats a skipped optional field (_No response_) as absent', () => {
    const body = [
      '### Goal',
      '',
      'Ship it.',
      '',
      '### Changes',
      '',
      '_No response_',
      '',
      '### Acceptance',
      '',
      '- done',
      '',
      '### Verify',
      '',
      '- npm test (unit)',
    ].join('\n');
    const verdict = evaluateIssueBody(body);
    assert.equal(verdict.conformant, true);
  });
});

describe('evaluateIssueBody — non-conformant bodies', () => {
  it('flags an empty body', () => {
    const verdict = evaluateIssueBody('');
    assert.equal(verdict.conformant, false);
    assert.equal(verdict.parseFailed, true);
    assert.match(verdict.problems[0], /empty/);
  });

  it('flags a free-text (legacy string) body with no sections', () => {
    const verdict = evaluateIssueBody(
      'Please add a dark mode toggle to the settings page, thanks!',
    );
    assert.equal(verdict.conformant, false);
    assert.ok(verdict.problems.some((p) => /no recognised/.test(p)));
  });

  it('flags a body missing the required Verify section', () => {
    const body = ['## Goal', 'A goal.', '', '## Acceptance', '- it works'].join(
      '\n',
    );
    const verdict = evaluateIssueBody(body);
    assert.equal(verdict.conformant, false);
    assert.ok(verdict.problems.some((p) => /Verify/.test(p)));
  });
});

describe('renderConformanceComment', () => {
  it('carries the marker and lists each problem', () => {
    const verdict = evaluateIssueBody('## Goal\nonly a goal');
    const comment = renderConformanceComment(verdict);
    assert.ok(comment.startsWith(LINT_COMMENT_MARKER));
    for (const problem of verdict.problems) {
      assert.ok(comment.includes(problem));
    }
  });
});

describe('isStoryTicket / runLintIssueBody', () => {
  it('accepts type::story only', () => {
    assert.equal(isStoryTicket(['type::story']), true);
    assert.equal(isStoryTicket(['type::epic']), false);
    assert.equal(isStoryTicket(null), false);
  });

  it('skips non-story tickets without posting', () => {
    const calls = [];
    const out = [];
    const result = runLintIssueBody({
      issue: 9,
      ghFn: (args) => {
        calls.push(args);
        return JSON.stringify({
          body: '',
          labels: [{ name: 'type::epic' }],
        });
      },
      write: (s) => out.push(s),
    });
    assert.equal(result.skipped, 'not-a-ticket');
    assert.equal(calls.length, 1);
    assert.match(out.join(''), /not-a-ticket/);
  });

  it('evaluates a story body and posts on non-conformance', () => {
    const calls = [];
    const result = runLintIssueBody({
      issue: 3,
      dryRun: false,
      ghFn: (args) => {
        calls.push(args);
        if (args[0] === 'issue' && args[1] === 'view') {
          return JSON.stringify({
            body: '## Goal\nonly a goal',
            labels: [{ name: 'type::story' }],
          });
        }
        return '';
      },
      write: () => {},
    });
    assert.equal(result.conformant, false);
    assert.equal(
      calls.some((a) => a[1] === 'comment'),
      true,
    );
  });

  it('dry-run skips the comment post', () => {
    const calls = [];
    runLintIssueBody({
      issue: 3,
      dryRun: true,
      ghFn: (args) => {
        calls.push(args);
        return JSON.stringify({
          body: '## Goal\nonly a goal',
          labels: [{ name: 'type::story' }],
        });
      },
      write: () => {},
    });
    assert.equal(
      calls.some((a) => a[1] === 'comment'),
      false,
    );
  });
});
