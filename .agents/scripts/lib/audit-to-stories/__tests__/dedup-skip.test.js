/**
 * Colocated dedup tests (Story #4195, acceptance: dedup classifies a
 * known-fingerprint match as skip-*).
 *
 * The shared `classifyGroupsAgainstGitHub` is driven through the real
 * fingerprint footer the production path stamps into issue bodies (rendered
 * by `renderFingerprintFooter`), with an in-memory provider standing in for
 * the GitHubProvider `searchIssues` port. A known-fingerprint hit must
 * classify as `skip-open` (open issue) or `skip-reoccurring` (closed issue),
 * proving the dedup gate is no longer a silent no-op once a real
 * `searchIssues` port resolves.
 *
 * Also asserts the loud `dedupSkippedWarning` text the CLI emits when no
 * provider port resolves (or `--no-provider` is passed) — the operator-visible
 * signal that replaces the old invisible create-only fall-through.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { __testing as auditCli } from '../../../audit-to-stories.js';
import { classifyGroupsAgainstGitHub } from '../dedupe-against-github.js';
import {
  renderFingerprintFooter,
  withFingerprints,
} from '../finding-adapter.js';

const { dedupSkippedWarning } = auditCli;

/** Build a real, fingerprinted audit finding + its group. */
function auditFinding(dimension, normalisedTitle, file) {
  return { dimension, normalisedTitle, files: file ? [file] : [] };
}
function fakeGroup(findings) {
  const stamped = withFingerprints(findings);
  return { groupKey: `g-${stamped[0]?.fingerprint?.short}`, findings: stamped };
}
function footerFor(finding) {
  // The footer the dedup gate confirms identity against — exactly what the
  // story-body stamps into an opened issue.
  return renderFingerprintFooter(withFingerprints([finding]));
}
/** In-memory stand-in for the GitHubProvider searchIssues port. */
function inMemoryProvider(issues) {
  return {
    async findIssuesByFingerprint(sha) {
      return issues.filter(
        (i) => typeof i.body === 'string' && i.body.includes(sha),
      );
    },
  };
}

const FINDING = auditFinding('injection', 'sqli in login', 'src/a.js');

describe('dedup classifies a known-fingerprint match as skip-*', () => {
  it('skip-open when the matching issue is OPEN', async () => {
    const groups = [fakeGroup([FINDING])];
    const provider = inMemoryProvider([
      { number: 4182, state: 'OPEN', body: `body\n${footerFor(FINDING)}\n` },
    ]);

    const { classifications, summary } = await classifyGroupsAgainstGitHub({
      groups,
      provider,
    });

    assert.equal(classifications[0].action, 'skip-open');
    assert.equal(classifications[0].matchedIssues[0].number, 4182);
    assert.equal(summary.skipOpen, 1);
  });

  it('skip-reoccurring when the only match is a CLOSED issue (one of the prior closed audit::* findings)', async () => {
    const groups = [fakeGroup([FINDING])];
    const provider = inMemoryProvider([
      { number: 4076, state: 'CLOSED', body: footerFor(FINDING) },
    ]);

    const { classifications, summary } = await classifyGroupsAgainstGitHub({
      groups,
      provider,
    });

    assert.equal(classifications[0].action, 'skip-reoccurring');
    assert.equal(summary.skipReoccurring, 1);
  });

  it('create when no issue carries the fingerprint footer', async () => {
    const groups = [fakeGroup([FINDING])];
    const provider = inMemoryProvider([]);

    const { classifications, summary } = await classifyGroupsAgainstGitHub({
      groups,
      provider,
    });

    assert.equal(classifications[0].action, 'create');
    assert.equal(summary.create, 1);
  });
});

describe('dedupSkippedWarning (loud, operator-visible)', () => {
  it('names the missing provider port and warns duplicates will be opened', () => {
    const msg = dedupSkippedWarning('no-provider-port');
    assert.match(msg, /dedup skipped \(no provider port\)/i);
    assert.match(msg, /searchIssues/);
    assert.match(msg, /duplicate/i);
  });

  it('frames --no-provider as a deliberate opt-out, still warning of duplicates', () => {
    const msg = dedupSkippedWarning('disabled');
    assert.match(msg, /dedup skipped \(--no-provider\)/i);
    assert.match(msg, /duplicate/i);
  });
});
