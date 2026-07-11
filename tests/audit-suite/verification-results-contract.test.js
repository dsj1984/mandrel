/**
 * tests/audit-suite/verification-results-contract.test.js — Story #4411,
 * Epic #4405.
 *
 * Pins the unified `verification-results` findings contract that replaces the
 * two former `code-review` and `audit-results` structured-comment contracts:
 *
 *   - ONE structured-comment marker ({@link VERIFICATION_RESULTS_MARKER})
 *     replaces the two retired per-graduator markers. Both feedback-loop
 *     graduators (`graduateFindings` / `graduateAuditResults`, both via the
 *     shared `graduate()` walk in graduator-core) file follow-ups from that
 *     one marker and both surface the single
 *     {@link NO_VERIFICATION_RESULTS_COMMENT_REASON} when it is absent.
 *   - ONE remediation loop: the shared `graduate()` walk. A single mixed
 *     findings set (critical + high + medium + suggestion + a Fixed-on-branch
 *     entry) is driven through both graduators and yields the same
 *     non-blocking graduated set.
 *   - ONE halting rule: a surviving Critical still halts and never graduates
 *     ({@link hasSurvivingCritical}); Fixed-on-branch entries never graduate.
 *
 * All gh/git child processes are stubbed via the `spawnImpl` seam and the
 * ticketing provider is a stub — no real network, git, or filesystem access.
 */

import { strict as assert } from 'node:assert';
import { EventEmitter } from 'node:events';
import { describe, it } from 'node:test';

import { hasSurvivingCritical } from '../../.agents/scripts/lib/audit-suite/findings.js';
import { graduateAuditResults } from '../../.agents/scripts/lib/feedback-loop/audit-results-graduator.js';
import { graduateFindings } from '../../.agents/scripts/lib/feedback-loop/code-review-graduator.js';
import {
  NO_VERIFICATION_RESULTS_COMMENT_REASON,
  VERIFICATION_RESULTS_MARKER,
} from '../../.agents/scripts/lib/feedback-loop/graduator-core.js';
import { structuredCommentMarker } from '../../.agents/scripts/lib/orchestration/ticketing.js';

/**
 * Build a spawn stub routing by command / first arg. `git cat-file` reports
 * every probed path present (code 0), `gh search` reports no prior filing
 * (empty array), and `gh issue create` succeeds with a stable URL.
 */
function makeSpawnStub(overrides = {}) {
  const calls = [];
  const fn = function spawnImpl(cmd, args) {
    calls.push({ cmd, args });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    let result;
    if (cmd === 'git') {
      result = overrides.git ? overrides.git(args) : { stdout: '', code: 0 };
    } else if (args[0] === 'search') {
      result = overrides.ghSearch
        ? overrides.ghSearch(args)
        : { stdout: '[]', code: 0 };
    } else if (args[0] === 'issue' && args[1] === 'create') {
      result = overrides.ghCreate
        ? overrides.ghCreate(args)
        : { stdout: 'https://github.com/acme/product/issues/7', code: 0 };
    } else {
      result = { stdout: '', code: 0 };
    }
    queueMicrotask(() => {
      if (result.stdout) child.stdout.emit('data', Buffer.from(result.stdout));
      if (result.stderr) child.stderr.emit('data', Buffer.from(result.stderr));
      child.emit('close', result.code ?? 0);
    });
    return child;
  };
  fn.calls = calls;
  return fn;
}

/** Provider stub returning a single comment carrying the given body. */
function makeProvider(body) {
  return { getTicketComments: async () => [{ body }] };
}

/**
 * A mixed verification-results findings body: one surviving Critical (must
 * halt, never graduate), one each of the non-blocking tiers under an
 * `audit-security` lens heading, and a Fixed-on-branch entry (never
 * graduates). All paths are consumer paths so they file against the current
 * repo rather than cross-repo-deferring.
 */
const MIXED_FINDINGS = [
  '## 🔬 Code Review — Epic #4405',
  '',
  '### 📦 Severity Tier Counts',
  '- 🔴 Critical Blocker: 1',
  '- 🟠 High Risk: 1',
  '- 🟡 Medium Risk: 1',
  '- 🟢 Suggestion: 1',
  '',
  '#### audit-security',
  '🔴 Critical Blocker: `src/critical.js` (surviving — must halt)',
  '🟠 High Risk: `src/high.js` (non-blocking)',
  '🟡 Medium Risk: `src/medium.js` (non-blocking)',
  '🟢 Suggestion: `src/suggestion.js` (non-blocking)',
  '',
  '## Fixed on-branch',
  '- ✅ 🟡 Medium (audit-security): `src/fixed.js` — remediated (abc1234)',
].join('\n');

const CONSUMER_REPO = { owner: 'acme', repo: 'product' };
const FRAMEWORK_REPO = { owner: 'dsj1984', repo: 'mandrel' };

const NON_GRADUATING = ['src/critical.js', 'src/fixed.js'];

describe('verification-results contract — single unified marker', () => {
  it('is the canonical structured-comment marker for the unified type', () => {
    assert.equal(
      VERIFICATION_RESULTS_MARKER,
      structuredCommentMarker('verification-results'),
    );
  });

  it('is not either of the two retired per-graduator markers', () => {
    assert.notEqual(
      VERIFICATION_RESULTS_MARKER,
      '<!-- structured-comment: code-review -->',
    );
    assert.notEqual(
      VERIFICATION_RESULTS_MARKER,
      '<!-- claude-managed: audit-results -->',
    );
  });

  it('both graduators skip a body that lacks the unified marker', async () => {
    const provider = makeProvider(`no marker here\n${MIXED_FINDINGS}`);
    for (const graduate of [graduateFindings, graduateAuditResults]) {
      const result = await graduate({
        epicId: 4405,
        provider,
        config: {},
        currentRepo: CONSUMER_REPO,
      });
      assert.deepEqual(result.filed, []);
      assert.equal(result.skipped.length, 1);
      assert.equal(
        result.skipped[0].reason,
        NO_VERIFICATION_RESULTS_COMMENT_REASON,
      );
    }
  });
});

describe('verification-results contract — one remediation loop', () => {
  it('code-review graduator files the non-blocking tiers from the unified marker; halts the Critical and skips Fixed-on-branch', async () => {
    const provider = makeProvider(
      `${VERIFICATION_RESULTS_MARKER}\n${MIXED_FINDINGS}`,
    );
    const result = await graduateFindings({
      epicId: 4405,
      provider,
      config: {},
      currentRepo: CONSUMER_REPO,
      frameworkRepo: FRAMEWORK_REPO,
      spawnImpl: makeSpawnStub(),
    });
    assert.equal(result.errors.length, 0, JSON.stringify(result.errors));
    const filedPaths = result.filed.map((f) => f.path).sort();
    assert.deepEqual(filedPaths, [
      'src/high.js',
      'src/medium.js',
      'src/suggestion.js',
    ]);
    for (const path of NON_GRADUATING) {
      assert.ok(
        !filedPaths.includes(path),
        `${path} must not graduate (surviving Critical / Fixed-on-branch)`,
      );
    }
  });

  it('audit-results graduator files the same non-blocking set (lens-tagged) from the unified marker', async () => {
    const provider = makeProvider(
      `${VERIFICATION_RESULTS_MARKER}\n${MIXED_FINDINGS}`,
    );
    const result = await graduateAuditResults({
      epicId: 4405,
      provider,
      config: {},
      currentRepo: CONSUMER_REPO,
      frameworkRepo: FRAMEWORK_REPO,
      spawnImpl: makeSpawnStub(),
    });
    assert.equal(result.errors.length, 0, JSON.stringify(result.errors));
    const filedPaths = result.filed.map((f) => f.path).sort();
    assert.deepEqual(filedPaths, [
      'src/high.js',
      'src/medium.js',
      'src/suggestion.js',
    ]);
    for (const filed of result.filed) {
      assert.equal(filed.lens, 'audit-security');
    }
    for (const path of NON_GRADUATING) {
      assert.ok(
        !filedPaths.includes(path),
        `${path} must not graduate (surviving Critical / Fixed-on-branch)`,
      );
    }
  });
});

describe('verification-results contract — one halting rule', () => {
  it('a surviving Critical halts (count-object and Finding[] forms)', () => {
    assert.equal(hasSurvivingCritical({ critical: 1 }), true);
    assert.equal(hasSurvivingCritical({ critical: 0 }), false);
    assert.equal(
      hasSurvivingCritical([
        { severity: 'high' },
        { severity: 'critical' },
        { severity: 'medium' },
      ]),
      true,
    );
    assert.equal(
      hasSurvivingCritical([{ severity: 'high' }, { severity: 'medium' }]),
      false,
    );
  });

  it('an unparseable / absent Critical count is not a halt (fail-open sentinel)', () => {
    assert.equal(hasSurvivingCritical({ critical: null }), false);
    assert.equal(hasSurvivingCritical({}), false);
    assert.equal(hasSurvivingCritical(null), false);
    assert.equal(hasSurvivingCritical(undefined), false);
  });
});
