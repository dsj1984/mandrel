import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  filterConsoleMessages,
  isAllowlisted,
} from '../.agents/scripts/lib/qa/console-allowlist.js';

/**
 * Story #3295 — console-allowlist instrumentation filter.
 *
 * The QA harness (Epic #3214) captures per-surface console messages and turns
 * non-allowlisted console errors into structured findings while suppressing
 * benign noise matched by `qa.consoleAllowlist`. These tests pin the two
 * load-bearing behaviours from the Story's acceptance criteria:
 *
 *   1. a console error not matched by any allowlist pattern → a finding;
 *   2. a console message matched by an allowlist pattern → suppressed.
 */

describe('isAllowlisted', () => {
  it('matches a message text against any substring pattern', () => {
    assert.equal(
      isAllowlisted('ResizeObserver loop limit exceeded', [
        'ResizeObserver loop limit exceeded',
      ]),
      true,
    );
  });

  it('matches on a partial substring, not just full equality', () => {
    assert.equal(
      isAllowlisted('Download the React DevTools for a better experience', [
        'React DevTools',
      ]),
      true,
    );
  });

  it('returns false when no pattern matches', () => {
    assert.equal(
      isAllowlisted('Uncaught TypeError: x is not a function', [
        'ResizeObserver',
      ]),
      false,
    );
  });

  it('treats an empty or absent allowlist as no suppression', () => {
    assert.equal(isAllowlisted('anything', []), false);
    assert.equal(isAllowlisted('anything', undefined), false);
  });

  it('ignores blank patterns so they never swallow every error', () => {
    assert.equal(isAllowlisted('a real error', ['', '   ']), false);
  });
});

describe('filterConsoleMessages — non-allowlisted error becomes a finding', () => {
  it('emits exactly one finding for a console error with no allowlist match', () => {
    const messages = [
      { level: 'error', text: 'Uncaught TypeError: cannot read foo of null' },
    ];

    const findings = filterConsoleMessages(messages, ['ResizeObserver'], {
      surface: 'dashboard',
    });

    assert.equal(findings.length, 1);
    const [finding] = findings;
    assert.equal(finding.id, 'F1');
    assert.equal(finding.classification, 'console-error');
    assert.equal(finding.surface, 'dashboard');
    assert.equal(
      finding.symptom,
      'Uncaught TypeError: cannot read foo of null',
    );
    assert.deepEqual(finding.evidence.console, [
      { level: 'error', text: 'Uncaught TypeError: cannot read foo of null' },
    ]);
    assert.deepEqual(finding.evidence.network, []);
  });

  it('escalates a severe-level message and assigns sequential ids', () => {
    const messages = [
      { level: 'error', text: 'first failure' },
      { type: 'severe', message: 'second failure' },
    ];

    const findings = filterConsoleMessages(messages, []);

    assert.deepEqual(
      findings.map((f) => f.id),
      ['F1', 'F2'],
    );
    assert.deepEqual(
      findings.map((f) => f.symptom),
      ['first failure', 'second failure'],
    );
  });

  it('never escalates non-error levels', () => {
    const messages = [
      { level: 'log', text: 'just a log line' },
      { level: 'info', text: 'informational' },
      { level: 'warning', text: 'a warning, not an error' },
    ];

    assert.deepEqual(filterConsoleMessages(messages, []), []);
  });
});

describe('filterConsoleMessages — allowlisted message is suppressed', () => {
  it('produces no finding for an error matched by an allowlist pattern', () => {
    const messages = [
      { level: 'error', text: 'ResizeObserver loop limit exceeded' },
    ];

    const findings = filterConsoleMessages(messages, [
      'ResizeObserver loop limit exceeded',
    ]);

    assert.deepEqual(findings, []);
  });

  it('suppresses only the allowlisted error and keeps the rest', () => {
    const messages = [
      { level: 'error', text: 'ResizeObserver loop limit exceeded' },
      { level: 'error', text: 'Uncaught ReferenceError: bar is not defined' },
    ];

    const findings = filterConsoleMessages(
      messages,
      ['ResizeObserver loop limit exceeded'],
      { surface: 'checkout' },
    );

    assert.equal(findings.length, 1);
    assert.equal(findings[0].id, 'F1');
    assert.equal(
      findings[0].symptom,
      'Uncaught ReferenceError: bar is not defined',
    );
    assert.equal(findings[0].surface, 'checkout');
  });
});

describe('filterConsoleMessages — defensive input handling', () => {
  it('returns an empty array for a non-array input', () => {
    assert.deepEqual(filterConsoleMessages(null), []);
    assert.deepEqual(filterConsoleMessages(undefined), []);
  });

  it('is deterministic across repeated runs over the same input', () => {
    const messages = [
      { level: 'error', text: 'error A' },
      { level: 'error', text: 'benign B' },
      { level: 'error', text: 'error C' },
    ];
    const allowlist = ['benign B'];

    const first = filterConsoleMessages(messages, allowlist);
    const second = filterConsoleMessages(messages, allowlist);

    assert.deepEqual(first, second);
    assert.deepEqual(
      first.map((f) => f.symptom),
      ['error A', 'error C'],
    );
  });
});
