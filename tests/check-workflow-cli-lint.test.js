/**
 * Unit coverage for check-workflow-cli-lint.js (Epic #4474 PR5).
 *
 * The rule: no workflow may instruct calling an exported library function
 * that has no CLI entrypoint — the measured shim-writing failure mode of
 * the retired 12-phase /plan pipeline (the bench cohort spent ~12–15 turns
 * writing throwaway `.mjs` shims to invoke `findSimilarOpenEpics` and
 * friends).
 *
 * Strategy: drive `lintWorkflowSource` with the exact retired prose shapes
 * (must flag) and the surviving descriptive shapes (must NOT flag), then
 * prove `runCheck` over the real `.agents/workflows/` corpus is clean —
 * the zero-false-positive tuning requirement, and the regression guard
 * that keeps the pattern from re-entering a workflow.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  lintWorkflowSource,
  runCheck,
  stripFences,
  toParagraphs,
} from '../.agents/scripts/check-workflow-cli-lint.js';

describe('workflow-cli-lint — flags the retired no-CLI instruction shapes', () => {
  it('flags the imperative "Call `fn(...)` exported from" paragraph (retired Phase 2 shape)', () => {
    const source = [
      '1. **Invoke the duplicate-search module**: Call',
      '   `findSimilarOpenEpics({ onePager, provider })` exported from',
      '   [`.agents/scripts/lib/duplicate-search.js`](../../scripts/lib/duplicate-search.js).',
    ].join('\n');
    const violations = lintWorkflowSource(source);
    assert.equal(violations.length, 1);
    assert.equal(violations[0].rule, 'no-cli-library-call');
    assert.equal(violations[0].line, 1);
  });

  it('flags an imperative call even without "exported from" (retired Phase 4 shape)', () => {
    const source = [
      '1. **Open the Epic Issue**: Call',
      '   `openEpicFromOnePager({ onePager, template, createIssue })` from the',
      '   same `epic-plan-ideation.js` module.',
    ].join('\n');
    const violations = lintWorkflowSource(source);
    assert.equal(violations.length, 1);
    assert.equal(violations[0].rule, 'no-cli-library-call');
  });

  it('flags a prose-level scripts/lib import instruction', () => {
    const source =
      "To read the state, run import('./.agents/scripts/lib/foo/bar.js') and inspect the result.";
    const violations = lintWorkflowSource(source);
    assert.equal(violations.length, 1);
    assert.equal(violations[0].rule, 'no-prose-lib-import');
  });

  it('reports one violation per offending paragraph with a remediation hint', () => {
    const source = [
      'Call `renderEpicBody({ onePager, template })` exported from the lib.',
      '',
      'Call `openEpicFromOnePager({ onePager })` from the same module.',
    ].join('\n');
    const violations = lintWorkflowSource(source);
    assert.equal(violations.length, 2);
    for (const v of violations) {
      assert.match(v.hint, /node \.agents\/scripts\/<cli>\.js/);
    }
  });
});

describe('workflow-cli-lint — does NOT flag descriptive or runnable shapes', () => {
  it('ignores descriptive lowercase "paths call `fn()`" prose (worktree-lifecycle shape)', () => {
    const source =
      'All automatic paths call `forceDrainPendingCleanup()` (or are folded into ' +
      'the sweep) before touching `.worktrees/`; see `scripts/lib/worktree.js`.';
    assert.deepEqual(lintWorkflowSource(source), []);
  });

  it('ignores a bare function-name mention with no imperative', () => {
    const source =
      'The seam is `resolveQaContract(config)`. The resolver returns the ' +
      'normalized contract.';
    assert.deepEqual(lintWorkflowSource(source), []);
  });

  it('exempts complete runnable commands inside fenced code blocks', () => {
    const source = [
      'Resolve the contract:',
      '',
      '```bash',
      'node -e "import(\'./.agents/scripts/lib/qa/resolve-qa-contract.js\').then(m => m.run())"',
      '```',
    ].join('\n');
    assert.deepEqual(lintWorkflowSource(source), []);
  });

  it('ignores instructions to run a real CLI', () => {
    const source =
      'Run `node .agents/scripts/plan-context.js --epic 42` and read the envelope.';
    assert.deepEqual(lintWorkflowSource(source), []);
  });
});

describe('workflow-cli-lint — helpers', () => {
  it('stripFences blanks fenced lines but preserves line count', () => {
    const source = 'a\n```\ncode\n```\nb';
    const lines = stripFences(source);
    assert.equal(lines.length, 5);
    assert.equal(lines[0], 'a');
    assert.equal(lines[2], '');
    assert.equal(lines[4], 'b');
  });

  it('toParagraphs records the 1-based first line of each paragraph', () => {
    const paras = toParagraphs(['', 'one', 'two', '', 'three']);
    assert.equal(paras.length, 2);
    assert.equal(paras[0].line, 2);
    assert.equal(paras[0].text, 'one two');
    assert.equal(paras[1].line, 5);
  });
});

describe('workflow-cli-lint — no-cli-flag-table (Story #4546)', () => {
  it('flags a table restating a script CLI flag surface named in the heading', () => {
    const source = [
      '## Step 3 — Close (`single-story-close.js`)',
      '',
      '| Flag | Meaning |',
      '| --- | --- |',
      '| `--skip-validation` | Bypass the gates. |',
      '| `--skip-sync` | Bypass the base-sync. |',
      '| `--no-auto-merge` | Disable auto-merge. |',
      '',
    ].join('\n');

    const violations = lintWorkflowSource(source);

    assert.equal(violations.length, 1);
    assert.equal(violations[0].rule, 'no-cli-flag-table');
    assert.equal(violations[0].line, 3);
    assert.match(violations[0].hint, /single-story-close\.js/);
    assert.match(violations[0].hint, /point at the command/);
  });

  it('flags a table whose script is named in a fenced command above it', () => {
    const source = [
      '## Draining the ledger',
      '',
      '```bash',
      'node .agents/scripts/drain-pending-cleanup.js',
      '```',
      '',
      '| Flag | Meaning |',
      '| --- | --- |',
      '| `--no-escalate` | Passive drain only. |',
      '| `--dry-run` | Inspect without acting. |',
      '',
    ].join('\n');

    const violations = lintWorkflowSource(source);

    assert.equal(violations.length, 1);
    assert.equal(violations[0].rule, 'no-cli-flag-table');
    assert.match(violations[0].hint, /drain-pending-cleanup\.js/);
  });

  it("does NOT flag a slash command's own flag table (no script owns those flags)", () => {
    // `/plan` and `/deliver` document their own argument surface; there is no
    // CLI `--help` behind it, so this is the single home for that contract.
    const source = [
      '## Flags',
      '',
      '| Flag | Meaning |',
      '| --- | --- |',
      '| `--concurrency <n>` | Ready-set fan-out cap. |',
      '| `--yes` | Suppress the confirmation gate. |',
      '| `--steal` | Forwarded to the lease steal. |',
      '',
    ].join('\n');

    assert.deepEqual(lintWorkflowSource(source), []);
  });

  it('does NOT flag a behaviour/contract table that happens to key one row by flag', () => {
    const source = [
      '### Closing superseded source tickets (`plan-persist.js`)',
      '',
      '| Behaviour | Contract |',
      '| --- | --- |',
      '| Default | Comment + close every source ticket. |',
      '| `--no-close-superseded` | Skips commenting and closing. |',
      '| Re-run | Idempotent. |',
      '',
    ].join('\n');

    assert.deepEqual(lintWorkflowSource(source), []);
  });
});

describe('workflow-cli-lint — corpus and fixture-driven runCheck', () => {
  it('the real .agents/workflows corpus is clean (zero false positives, no regressions)', () => {
    const violations = runCheck();
    assert.deepEqual(
      violations,
      [],
      `workflow prose instructs a no-CLI library call:\n${violations
        .map((v) => `${v.file}:${v.line} [${v.rule}]`)
        .join('\n')}`,
    );
  });

  it('runCheck over a fixture directory surfaces file-relative violations', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-cli-lint-'));
    try {
      fs.mkdirSync(path.join(dir, 'helpers'));
      fs.writeFileSync(
        path.join(dir, 'helpers', 'bad.md'),
        'Call `renderEpicBody({ onePager })` exported from the ideation lib.\n',
      );
      fs.writeFileSync(path.join(dir, 'good.md'), '# clean\n\nRun the CLI.\n');
      const violations = runCheck(dir);
      assert.equal(violations.length, 1);
      assert.match(violations[0].file, /bad\.md$/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
