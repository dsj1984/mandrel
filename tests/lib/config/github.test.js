import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  BRANCH_PROTECTION_DEFAULTS,
  DEFAULT_REQUIRED_CHECKS,
  getGitHub,
  MERGE_METHODS_DEFAULTS,
  NOTIFICATIONS_DEFAULTS,
} from '../../../.agents/scripts/lib/config/github.js';

/**
 * Contract tests for the `github.*` resolver introduced by Epic #1720
 * Story #1739. Coverage was missing from the original Story; Story #1737
 * adds it to keep the absolute CRAP ceiling clear on
 * `config/github.js::getGitHub`.
 */

describe('getGitHub — defaults', () => {
  it('returns null identity fields and default sub-blocks for empty input', () => {
    const out = getGitHub({});
    assert.equal(out.owner, null);
    assert.equal(out.repo, null);
    assert.equal(out.projectNumber, null);
    assert.equal(out.projectOwner, null);
    assert.equal(out.operatorHandle, null);
    assert.equal(
      out.branchProtection.enforce,
      BRANCH_PROTECTION_DEFAULTS.enforce,
    );
    assert.deepEqual(out.mergeMethods, MERGE_METHODS_DEFAULTS);
    assert.deepEqual(out.notifications, NOTIFICATIONS_DEFAULTS);
  });

  it('returns DEFAULT_REQUIRED_CHECKS as a fresh copy when none supplied', () => {
    const out = getGitHub({});
    assert.deepEqual(
      out.branchProtection.requiredChecks,
      DEFAULT_REQUIRED_CHECKS,
    );
  });

  it('returns defaults when config is null/undefined', () => {
    const a = getGitHub(null);
    const b = getGitHub(undefined);
    assert.equal(a.owner, null);
    assert.equal(b.owner, null);
  });
});

describe('getGitHub — operator overrides', () => {
  it('reads the top-level github block', () => {
    const out = getGitHub({
      github: {
        owner: 'dsj1984',
        repo: 'mandrel',
        projectNumber: 1,
        projectOwner: 'dsj1984',
        operatorHandle: '@dsj1984',
      },
    });
    assert.equal(out.owner, 'dsj1984');
    assert.equal(out.repo, 'mandrel');
    assert.equal(out.projectNumber, 1);
    assert.equal(out.projectOwner, 'dsj1984');
    assert.equal(out.operatorHandle, '@dsj1984');
  });

  it('reads the legacy orchestration.github bag', () => {
    const out = getGitHub({
      orchestration: { github: { owner: 'org', repo: 'repo' } },
    });
    assert.equal(out.owner, 'org');
    assert.equal(out.repo, 'repo');
  });

  it('overrides branchProtection.enforce when explicitly set to false', () => {
    const out = getGitHub({
      github: { branchProtection: { enforce: false } },
    });
    assert.equal(out.branchProtection.enforce, false);
    assert.deepEqual(
      out.branchProtection.requiredChecks,
      DEFAULT_REQUIRED_CHECKS,
    );
  });

  it('replaces requiredChecks wholesale (no extender semantics)', () => {
    const custom = [{ name: 'typecheck', cmd: ['npm', 'run', 'typecheck'] }];
    const out = getGitHub({
      github: { branchProtection: { requiredChecks: custom } },
    });
    assert.deepEqual(out.branchProtection.requiredChecks, custom);
  });

  it('shallow-merges mergeMethods over defaults', () => {
    const out = getGitHub({
      github: { mergeMethods: { allow_rebase_merge: true } },
    });
    assert.equal(out.mergeMethods.allow_rebase_merge, true);
    assert.equal(out.mergeMethods.allow_squash_merge, true);
  });

  it('reads notifications from the github block', () => {
    const out = getGitHub({
      github: {
        notifications: {
          mentionOperator: true,
          commentEvents: ['state-transition'],
        },
      },
    });
    assert.equal(out.notifications.mentionOperator, true);
    assert.deepEqual(out.notifications.commentEvents, ['state-transition']);
    assert.deepEqual(
      out.notifications.webhookEvents,
      NOTIFICATIONS_DEFAULTS.webhookEvents,
    );
  });

  it('falls back to legacy orchestration.notifications when github.notifications is absent', () => {
    const out = getGitHub({
      github: { owner: 'o', repo: 'r' },
      orchestration: { notifications: { mentionOperator: true } },
    });
    assert.equal(out.notifications.mentionOperator, true);
  });

  it('ignores non-array requiredChecks (falls back to defaults)', () => {
    const out = getGitHub({
      github: { branchProtection: { requiredChecks: 'not-an-array' } },
    });
    assert.deepEqual(
      out.branchProtection.requiredChecks,
      DEFAULT_REQUIRED_CHECKS,
    );
  });

  it('ignores non-array notifications arrays (falls back to defaults)', () => {
    const out = getGitHub({
      github: {
        notifications: { commentEvents: 'not-array', webhookEvents: null },
      },
    });
    assert.deepEqual(
      out.notifications.commentEvents,
      NOTIFICATIONS_DEFAULTS.commentEvents,
    );
    assert.deepEqual(
      out.notifications.webhookEvents,
      NOTIFICATIONS_DEFAULTS.webhookEvents,
    );
  });

  it('treats non-object branchProtection as empty', () => {
    const out = getGitHub({ github: { branchProtection: 'invalid' } });
    assert.equal(out.branchProtection.enforce, true);
  });

  it('treats non-object mergeMethods as empty', () => {
    const out = getGitHub({ github: { mergeMethods: 'invalid' } });
    assert.deepEqual(out.mergeMethods, MERGE_METHODS_DEFAULTS);
  });
});
