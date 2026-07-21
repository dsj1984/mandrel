/**
 * Soft-fail dedup: a lookup that cannot complete degrades one group to
 * `create` instead of aborting the whole scan (Story #4678, AC-6 / AC-7).
 *
 * `classifyGroupsAgainstGitHub` stays pure orchestration — it accepts an
 * optional `onDegraded` sink and reports `summary.dedupDegraded`. A search port
 * that throws HTTP 422 for one group must not stop the remaining groups from
 * keeping their real classifications.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { __testing as auditCli } from '../../../audit-to-stories.js';
import { classifyGroupsAgainstGitHub } from '../dedupe-against-github.js';
import {
  renderFingerprintFooter,
  withFingerprints,
} from '../finding-adapter.js';

const { dedupDegradedWarning } = auditCli;

function auditFinding(dimension, normalisedTitle, file) {
  return { dimension, normalisedTitle, files: file ? [file] : [] };
}
function fakeGroup(key, findings) {
  const stamped = withFingerprints(findings);
  return { groupKey: key, findings: stamped };
}
function footerFor(finding) {
  return renderFingerprintFooter(withFingerprints([finding]));
}

const OPEN_FINDING = auditFinding('security', 'sqli in login', 'src/a.js');
const BAD_FINDING = auditFinding('perf', 'n+1 in report', 'src/b.js');

/**
 * A provider whose fingerprint lookup throws for the finding in `failGroupSha`
 * (simulating an HTTP 422 the endpoint budget could not absorb) and otherwise
 * resolves against an in-memory issue set carrying `footerFor(OPEN_FINDING)`.
 */
function partiallyFailingProvider(failSha) {
  const openBody = `body\n${footerFor(OPEN_FINDING)}\n`;
  return {
    async findIssuesByFingerprint(sha) {
      if (sha === failSha) {
        const err = new Error('Validation Failed: query too long');
        err.status = 422;
        throw err;
      }
      return [{ number: 4182, state: 'OPEN', body: openBody }].filter((i) =>
        i.body.includes(sha),
      );
    },
  };
}

describe('classifyGroupsAgainstGitHub soft-fail', () => {
  it('AC-6: a 422 for one group degrades it to create, others keep their classification', async () => {
    const openGroup = fakeGroup('g-open', [OPEN_FINDING]);
    const badGroup = fakeGroup('g-bad', [BAD_FINDING]);
    const badSha = badGroup.findings[0].fingerprint.full;

    const degraded = [];
    const { classifications, summary } = await classifyGroupsAgainstGitHub({
      groups: [openGroup, badGroup],
      provider: partiallyFailingProvider(badSha),
      onDegraded: (entry) => degraded.push(entry),
    });

    const byKey = Object.fromEntries(
      classifications.map((c) => [c.group.groupKey, c.action]),
    );
    assert.equal(byKey['g-open'], 'skip-open', 'healthy group keeps its match');
    assert.equal(byKey['g-bad'], 'create', 'failed group degrades to create');
    assert.equal(summary.skipOpen, 1);
    assert.equal(summary.create, 1);
    // AC-7: the degrade is reported, not silent.
    assert.equal(summary.dedupDegraded.count, 1);
    assert.equal(summary.dedupDegraded.groups[0].group, 'g-bad');
    assert.match(summary.dedupDegraded.groups[0].reason, /422/);
    assert.equal(degraded.length, 1, 'onDegraded sink fired once');
    assert.equal(degraded[0].group.groupKey, 'g-bad');
  });

  it('reports zero degradations when every lookup completes', async () => {
    const openGroup = fakeGroup('g-open', [OPEN_FINDING]);
    const { summary } = await classifyGroupsAgainstGitHub({
      groups: [openGroup],
      provider: partiallyFailingProvider('never-matches'),
    });
    assert.equal(summary.dedupDegraded.count, 0);
    assert.deepEqual(summary.dedupDegraded.groups, []);
  });
});

describe('dedupDegradedWarning (loud, operator-visible)', () => {
  it('names each affected group and its reason and warns of possible duplicates', () => {
    const msg = dedupDegradedWarning([
      { group: 'g-bad', reason: 'search query rejected (HTTP 422)' },
    ]);
    assert.match(msg, /dedup degraded for 1 group/i);
    assert.match(msg, /g-bad/);
    assert.match(msg, /422/);
    assert.match(msg, /duplicate/i);
  });
});
