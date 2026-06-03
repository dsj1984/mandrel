/**
 * manifest.test — Story #3521 (Feature #3515, Epic #3438)
 *
 * The mutation manifest is the single source the consent-first phased
 * install previews before any write lands. These unit tests pin its
 * contract:
 *
 *   - every entry carries the five preview fields (phaseGroup, target,
 *     action, detail, reversible);
 *   - every entry's phaseGroup is one of the four approvable groups;
 *   - the flag-honouring partition (skipGithub / skipQuality);
 *   - and that `applyProjectBootstrap`'s no-write preview is derived from
 *     `buildMutationManifest` so preview and execution share one source.
 *
 * Pure logic — no filesystem or network I/O — so this is a unit-tier suite.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildMutationManifest,
  MANIFEST_ENTRY_FIELDS,
  PHASE_GROUP_VALUES,
  PHASE_GROUPS,
  previewMutationManifest,
} from '../../.agents/scripts/lib/bootstrap/manifest.js';
import { applyProjectBootstrap } from '../../.agents/scripts/lib/bootstrap/project-bootstrap.js';

const CTX = Object.freeze({
  projectRoot: '/tmp/consumer',
  answers: { owner: 'acme', repo: 'widget', baseBranch: 'main' },
});

describe('PHASE_GROUPS', () => {
  it('declares exactly the four approvable phase groups', () => {
    assert.deepEqual([...PHASE_GROUP_VALUES].sort(), [
      'github-admin',
      'ide-wiring',
      'quality-gates',
      'repo-config',
    ]);
  });
});

describe('buildMutationManifest', () => {
  it('returns a non-empty array', () => {
    const manifest = buildMutationManifest(CTX);
    assert.ok(Array.isArray(manifest));
    assert.ok(manifest.length > 0);
  });

  it('gives every entry the five required preview fields', () => {
    const manifest = buildMutationManifest(CTX);
    for (const entry of manifest) {
      for (const field of MANIFEST_ENTRY_FIELDS) {
        assert.ok(
          Object.hasOwn(entry, field),
          `entry missing field "${field}": ${JSON.stringify(entry)}`,
        );
      }
      assert.equal(typeof entry.target, 'string');
      assert.ok(entry.target.length > 0);
      assert.equal(typeof entry.action, 'string');
      assert.ok(entry.action.length > 0);
      assert.equal(typeof entry.detail, 'string');
      assert.ok(entry.detail.length > 0);
      assert.equal(typeof entry.reversible, 'boolean');
    }
  });

  it('keeps every entry phaseGroup within the four approvable groups', () => {
    const manifest = buildMutationManifest(CTX);
    for (const entry of manifest) {
      assert.ok(
        PHASE_GROUP_VALUES.has(entry.phaseGroup),
        `unexpected phaseGroup "${entry.phaseGroup}"`,
      );
    }
  });

  it('covers all four phase groups by default', () => {
    const groups = new Set(buildMutationManifest(CTX).map((e) => e.phaseGroup));
    assert.deepEqual([...groups].sort(), [...PHASE_GROUP_VALUES].sort());
  });

  it('omits the github-admin group when skipGithub is set', () => {
    const groups = new Set(
      buildMutationManifest({ ...CTX, skipGithub: true }).map(
        (e) => e.phaseGroup,
      ),
    );
    assert.equal(groups.has(PHASE_GROUPS.GITHUB_ADMIN), false);
    assert.equal(groups.has(PHASE_GROUPS.IDE_WIRING), true);
  });

  it('omits the quality-gates group when skipQuality is set', () => {
    const groups = new Set(
      buildMutationManifest({ ...CTX, skipQuality: true }).map(
        (e) => e.phaseGroup,
      ),
    );
    assert.equal(groups.has(PHASE_GROUPS.QUALITY_GATES), false);
    assert.equal(groups.has(PHASE_GROUPS.REPO_CONFIG), true);
  });

  it('marks github-admin mutations as not trivially reversible', () => {
    const githubEntries = buildMutationManifest(CTX).filter(
      (e) => e.phaseGroup === PHASE_GROUPS.GITHUB_ADMIN,
    );
    assert.ok(githubEntries.length > 0);
    for (const entry of githubEntries) {
      assert.equal(entry.reversible, false);
    }
  });

  it('renders github-admin targets against the resolved repo slug', () => {
    const manifest = buildMutationManifest(CTX);
    const labels = manifest.find((e) => e.target === 'acme/widget labels');
    assert.ok(labels, 'expected a labels entry scoped to acme/widget');
  });
});

describe('previewMutationManifest', () => {
  it('groups the flat manifest by phaseGroup', () => {
    const preview = previewMutationManifest(CTX);
    assert.equal(preview.preview, true);
    assert.deepEqual(preview.entries, buildMutationManifest(CTX));
    const regrouped = Object.values(preview.groups).flat();
    assert.equal(regrouped.length, preview.entries.length);
    for (const [group, entries] of Object.entries(preview.groups)) {
      for (const entry of entries) {
        assert.equal(entry.phaseGroup, group);
      }
    }
  });
});

describe('applyProjectBootstrap preview', () => {
  it('derives its no-write preview from buildMutationManifest', async () => {
    const result = await applyProjectBootstrap({ ...CTX, preview: true });
    assert.equal(result.preview, true);
    // Same source: the preview entries are exactly the manifest entries.
    assert.deepEqual(result.entries, buildMutationManifest(CTX));
    assert.deepEqual(result, previewMutationManifest(CTX));
  });

  it('honours skip flags in the preview the same way buildMutationManifest does', async () => {
    const ctx = { ...CTX, preview: true, skipGithub: true, skipQuality: true };
    const result = await applyProjectBootstrap(ctx);
    assert.deepEqual(result.entries, buildMutationManifest(ctx));
    const groups = new Set(result.entries.map((e) => e.phaseGroup));
    assert.equal(groups.has(PHASE_GROUPS.GITHUB_ADMIN), false);
    assert.equal(groups.has(PHASE_GROUPS.QUALITY_GATES), false);
  });
});
