// tests/contract/audit-labels-bootstrap.test.js
//
// Story #3049 — contract test for `audit-labels-bootstrap.js`. Exercises
// `bootstrapAuditLabels({ owner, repo, gh })` with an in-process fake `gh`
// facade. No live GitHub calls.
//
// Coverage:
//   - missing owner/repo → throws.
//   - empty repo → every dimension is created.
//   - idempotent re-run against a complete label set → every dimension is
//     skipped, no creates fired.
//   - `gh label create` rejects → failures surface in the envelope.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  __testing,
  bootstrapAuditLabels,
  formatBootstrapReport,
  resolveOwnerRepo,
} from '../../.agents/scripts/audit-labels-bootstrap.js';

function makeGh({ existing = [], createBehaviour = 'ok' } = {}) {
  const calls = { listed: 0, created: [] };
  return {
    calls,
    label: {
      list: async () => {
        calls.listed += 1;
        return existing.map((name) => ({ name }));
      },
      create: async (name, _flags) => {
        calls.created.push(name);
        if (createBehaviour === 'ok') return undefined;
        if (createBehaviour === 'already-exists') {
          const err = new Error('label already exists');
          err.stderr = 'label already exists';
          throw err;
        }
        const err = new Error('gh label create blew up');
        err.stderr = 'gh label create blew up';
        throw err;
      },
    },
  };
}

describe('bootstrapAuditLabels — argument validation', () => {
  it('throws when owner is missing', async () => {
    await assert.rejects(
      () => bootstrapAuditLabels({ repo: 'r', gh: makeGh() }),
      /owner is required/,
    );
  });

  it('throws when repo is missing', async () => {
    await assert.rejects(
      () => bootstrapAuditLabels({ owner: 'o', gh: makeGh() }),
      /repo is required/,
    );
  });
});

describe('bootstrapAuditLabels — happy path on empty repo', () => {
  it('creates every audit:: label and reports them as created', async () => {
    const gh = makeGh({ existing: [] });
    const result = await bootstrapAuditLabels({ owner: 'o', repo: 'r', gh });
    assert.equal(result.failed.length, 0);
    assert.equal(result.skipped.length, 0);
    assert.equal(result.total, __testing.DIMENSIONS.length);
    assert.equal(result.created.length, __testing.DIMENSIONS.length);
    for (const dim of __testing.DIMENSIONS) {
      assert.ok(
        result.created.includes(`audit::${dim.name}`),
        `expected created to include audit::${dim.name}`,
      );
    }
    assert.equal(gh.calls.created.length, __testing.DIMENSIONS.length);
  });
});

describe('bootstrapAuditLabels — idempotent re-run', () => {
  it('skips every dimension when all labels already exist', async () => {
    const existing = __testing.DIMENSIONS.map((d) => `audit::${d.name}`);
    const gh = makeGh({ existing });
    const result = await bootstrapAuditLabels({ owner: 'o', repo: 'r', gh });
    assert.equal(result.created.length, 0);
    assert.equal(result.failed.length, 0);
    assert.equal(result.skipped.length, __testing.DIMENSIONS.length);
    assert.equal(
      gh.calls.created.length,
      0,
      'no label.create calls expected on full re-run',
    );
  });
});

describe('bootstrapAuditLabels — failure path', () => {
  it('records failures with the stderr reason when create rejects', async () => {
    const gh = makeGh({ existing: [], createBehaviour: 'error' });
    const result = await bootstrapAuditLabels({ owner: 'o', repo: 'r', gh });
    assert.equal(result.created.length, 0);
    assert.equal(result.failed.length, __testing.DIMENSIONS.length);
    for (const failure of result.failed) {
      assert.match(failure.reason, /blew up/);
    }
  });

  it('treats "already exists" stderr as skipped, not failed', async () => {
    const gh = makeGh({ existing: [], createBehaviour: 'already-exists' });
    const result = await bootstrapAuditLabels({ owner: 'o', repo: 'r', gh });
    assert.equal(result.failed.length, 0);
    assert.equal(result.skipped.length, __testing.DIMENSIONS.length);
    assert.equal(result.created.length, 0);
  });
});

describe('resolveOwnerRepo', () => {
  it('prefers CLI flag values over config', () => {
    const resolved = resolveOwnerRepo(
      { owner: 'flagOwner', repo: 'flagRepo' },
      { github: { owner: 'cfgOwner', repo: 'cfgRepo' } },
    );
    assert.deepEqual(resolved, { owner: 'flagOwner', repo: 'flagRepo' });
  });

  it('falls back to github.{owner,repo} config when flags absent', () => {
    const resolved = resolveOwnerRepo(
      {},
      { github: { owner: 'cfgOwner', repo: 'cfgRepo' } },
    );
    assert.deepEqual(resolved, { owner: 'cfgOwner', repo: 'cfgRepo' });
  });

  it('throws when neither flags nor config supply owner/repo', () => {
    assert.throws(() => resolveOwnerRepo({}, {}), /--owner and --repo/);
    assert.throws(
      () => resolveOwnerRepo({ owner: 'o' }, undefined),
      /--owner and --repo/,
    );
  });
});

describe('formatBootstrapReport', () => {
  it('renders only the summary line when nothing was created/skipped/failed', () => {
    const { stdout, stderr } = formatBootstrapReport({
      created: [],
      skipped: [],
      failed: [],
      total: 12,
    });
    assert.equal(
      stdout,
      'audit-labels-bootstrap: 0 created, 0 skipped, 0 failed (of 12).\n',
    );
    assert.equal(stderr, '');
  });

  it('includes created and skipped detail lines and failure stderr', () => {
    const { stdout, stderr } = formatBootstrapReport({
      created: ['audit::security'],
      skipped: ['audit::seo'],
      failed: [{ label: 'audit::sre', reason: 'boom' }],
      total: 12,
    });
    assert.match(stdout, /1 created, 1 skipped, 1 failed \(of 12\)\./);
    assert.match(stdout, /created: audit::security/);
    assert.match(stdout, /skipped: audit::seo/);
    assert.equal(stderr, '  FAILED audit::sre: boom\n');
  });
});
