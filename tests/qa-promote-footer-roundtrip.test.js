/**
 * tests/qa-promote-footer-roundtrip.test.js — Story #4115.
 *
 * The `/qa-assist` and `/qa-explore` Triage paths promote a
 * `file`-dispositioned finding through `/plan` (never a raw GitHub Issue).
 * For a tight cluster the seam is `createStory` → `/plan --from-notes`, which
 * persists through `story-plan.js --body <file>`. The dedup contract
 * (`route-finding.js`) only works on a *re*-run if the cluster's
 * `fingerprintFooter(sha)` survives verbatim into the issue body that the
 * Story create path writes — otherwise a future `routeFinding` re-files the
 * same finding instead of recognising it.
 *
 * This is a **contract** test of that round-trip: it does NOT add a new
 * `--fingerprint` flag (per the operator's decision); it asserts that the
 * existing `story-plan.js --body <file> --dry-run` resolved body carries the
 * footer unchanged, and that `parseFingerprintFooter` recovers the exact sha a
 * subsequent `routeFinding` would key off. The dry-run path is deterministic
 * and touches no network, so the assertion is hermetic.
 *
 * Three legs:
 *   (a) The resolved body the Story create path would send carries the footer
 *       byte-for-byte, and `parseFingerprintFooter` recovers the same sha.
 *   (b) The `--body-file` argv points at the unmodified seed file, so the
 *       footer the seam wrote is the footer GitHub receives.
 *   (c) The full promote → fingerprint identity is stable end to end: the sha
 *       a cluster fingerprints to is exactly the sha that survives the
 *       round-trip, closing the dedup loop.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { __testing as promoteTesting } from '../.agents/scripts/lib/findings/promote-finding.js';
import {
  fingerprintFinding,
  fingerprintFooter,
  parseFingerprintFooter,
} from '../.agents/scripts/lib/findings/route-finding.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const CLI = path.join(PROJECT_ROOT, '.agents', 'scripts', 'story-plan.js');

const { clusterToFinding } = promoteTesting;

/**
 * Render a minimal but schema-valid standalone Story seed body (the shape
 * `/plan --from-notes` produces) carrying the fingerprint footer the
 * `createStory` promotion seam stamps in.
 */
function renderSeedBody(sha) {
  return `# Address qa-coverage findings in feature:login

## Context

A clustered QA finding promoted from a /qa-explore session.

## Acceptance Criteria

- [ ] Close the coverage gap the finding surfaced.

## Out of Scope

Anything beyond the named surface.

## Notes

Promoted via promoteFindings → /plan --from-notes.

${fingerprintFooter(sha)}
`;
}

describe('qa promote → /plan footer round-trip (Story #4115)', () => {
  let tmp;
  // A representative cluster, shaped exactly as `clusterToFinding` emits so the
  // fingerprint matches what production routing computes.
  const cluster = {
    title: 'Address 2 test-gap findings in feature:login',
    coverages: ['feature:login'],
    class: 'test-gap',
    severity: 'high',
  };
  const finding = clusterToFinding(cluster);
  const { full: sha } = fingerprintFinding(finding);

  beforeEach(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'qa-footer-'));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('preserves the fingerprint footer verbatim in the resolved --from-notes body', () => {
    const seedPath = path.join(tmp, 'seed.md');
    writeFileSync(seedPath, renderSeedBody(sha));

    const r = spawnSync('node', [CLI, '--body', seedPath, '--dry-run'], {
      cwd: PROJECT_ROOT,
      encoding: 'utf8',
    });
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);

    // The resolved body the Story create path would send is echoed under the
    // `--- BODY ---` marker. The footer must survive byte-for-byte.
    const combined = `${r.stdout}\n${r.stderr}`;
    const expectedFooter = fingerprintFooter(sha);
    assert.ok(
      combined.includes(expectedFooter),
      `expected the resolved body to carry "${expectedFooter}" verbatim`,
    );

    // And a future routeFinding must recover the exact same sha from it.
    const recovered = parseFingerprintFooter(combined);
    assert.deepEqual(recovered, [sha]);
  });

  it('points the gh --body-file argv at the unmodified seed file', () => {
    const seedPath = path.join(tmp, 'seed.md');
    writeFileSync(seedPath, renderSeedBody(sha));

    const r = spawnSync('node', [CLI, '--body', seedPath, '--dry-run'], {
      cwd: PROJECT_ROOT,
      encoding: 'utf8',
    });
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);

    const parsed = JSON.parse(r.stdout.slice(r.stdout.indexOf('{')));
    assert.equal(parsed.dryRun, true);
    // The body GitHub receives IS the on-disk seed (which carries the footer);
    // the create path never rewrites it.
    const bodyFileIdx = parsed.argv.indexOf('--body-file');
    assert.notEqual(bodyFileIdx, -1, 'argv must carry --body-file');
    assert.equal(parsed.argv[bodyFileIdx + 1], seedPath);
  });

  it('keeps the cluster fingerprint stable end to end (dedup loop closes)', () => {
    // The sha a cluster fingerprints to is exactly the sha the footer carries,
    // so a re-promotion of the same cluster routes against the same identity.
    const reFinding = clusterToFinding(cluster);
    const { full: reSha } = fingerprintFinding(reFinding);
    assert.equal(reSha, sha);

    const body = renderSeedBody(sha);
    assert.deepEqual(parseFingerprintFooter(body), [reSha]);
  });
});
