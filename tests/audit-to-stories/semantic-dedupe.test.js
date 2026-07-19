/**
 * AC-4 (Story #4626): reworded duplicates are caught.
 *
 * With the semantic candidate port wired (as `loadProvider` wires it), a
 * finding whose title was rephrased but whose LOCATION matches an existing
 * Issue is classified a duplicate — even though its fingerprint has drifted.
 * This is a contract test driven through `loadProvider`: it injects an
 * in-memory issue store as the provider (via the createProvider/resolveConfig
 * seams) and exercises the exact fingerprint + semantic-candidate ports the
 * production adapter builds.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { __testing } from '../../.agents/scripts/audit-to-stories.js';
import { classifyGroupsAgainstGitHub } from '../../.agents/scripts/lib/audit-to-stories/dedupe-against-github.js';
import {
  renderFingerprintFooter,
  renderSemanticKeyFooter,
  withFingerprints,
} from '../../.agents/scripts/lib/audit-to-stories/finding-adapter.js';

const { loadProvider } = __testing;

function auditFinding(dimension, title, file) {
  return {
    dimension,
    title,
    normalisedTitle: title
      .toLowerCase()
      .replace(/[^a-z0-9 ]/g, '')
      .trim(),
    files: file ? [file] : [],
  };
}

/**
 * A contract-grade in-memory issue store standing in for the GitHub provider.
 * `searchIssues({ query })` returns every stored issue (the semantic scorer
 * and the footer-confirmation step do the filtering) so the store models a
 * full-text index, not a per-test stub.
 */
function fakeProviderWithIssues(issues) {
  return {
    createProviderImpl: () => ({
      async searchIssues() {
        return issues.map((i) => ({
          number: i.number,
          state: i.state,
          title: i.title ?? '',
          body: i.body ?? '',
        }));
      },
    }),
    resolveConfigImpl: () => ({ github: { owner: 'o', repo: 'r' } }),
  };
}

function fakeGroup(findings) {
  const stamped = withFingerprints(findings);
  return { groupKey: `g-${stamped[0].fingerprint.short}`, findings: stamped };
}

test('AC-4: a reworded finding at a matching location routes to skip-open through loadProvider ports', async () => {
  const original = auditFinding(
    'security',
    'SQL injection in login handler',
    'src/auth/login.js',
  );
  // The existing OPEN Issue was filed for the original finding: it carries the
  // fingerprint footer (of the original) AND the location-based semantic-key
  // footer.
  const existingIssue = {
    number: 314,
    state: 'open',
    title: 'SQL injection in login handler',
    body: [
      'Existing tracked finding.',
      renderFingerprintFooter(withFingerprints([original])),
      renderSemanticKeyFooter([original]),
    ].join('\n\n'),
  };

  const provider = await loadProvider(fakeProviderWithIssues([existingIssue]));
  assert.ok(
    provider,
    'loadProvider resolves a provider from the injected seam',
  );
  assert.equal(typeof provider.searchCandidates, 'function');

  // The reworded finding: same dimension + file, different title → different
  // fingerprint, identical semantic key.
  const reworded = auditFinding(
    'security',
    'Unparameterised query on the sign-in path',
    'src/auth/login.js',
  );
  const { classifications } = await classifyGroupsAgainstGitHub({
    groups: [fakeGroup([reworded])],
    provider,
    searchCandidates: provider.searchCandidates,
  });

  assert.equal(classifications[0].action, 'skip-open');
  assert.equal(classifications[0].matchedIssues[0].number, 314);
});

test('AC-4 guard: a reworded finding at a DIFFERENT location stays create', async () => {
  const original = auditFinding(
    'security',
    'SQL injection in login handler',
    'src/auth/login.js',
  );
  const existingIssue = {
    number: 315,
    state: 'open',
    title: 'SQL injection in login handler',
    body: renderSemanticKeyFooter([original]),
  };
  const provider = await loadProvider(fakeProviderWithIssues([existingIssue]));

  // Different file → different semantic key → not a match.
  const elsewhere = auditFinding(
    'security',
    'Unparameterised query on the sign-in path',
    'src/auth/register.js',
  );
  const { classifications } = await classifyGroupsAgainstGitHub({
    groups: [fakeGroup([elsewhere])],
    provider,
    searchCandidates: provider.searchCandidates,
  });
  assert.equal(classifications[0].action, 'create');
});
