import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  parseTagExpression,
  resolveSelection,
} from '../.agents/scripts/lib/qa/resolve-selection.js';

/**
 * Story #3296 — scenario-selection resolver for the agent-driven QA harness.
 *
 * The harness is invoked with a single selector (feature id, tag expression,
 * or domain) that scopes a sweep to a concrete set of `.feature` scenarios
 * under the contract's `featureRoot`. The resolver is deterministic: the
 * same selector against the same tree must produce the identical scenario
 * set on every run, sorted by (file, line).
 */

/**
 * Build a small but representative feature tree under a temp `featureRoot`:
 *
 *   <root>/login.feature                 — domain-less, @smoke / @wip
 *   <root>/billing/checkout.feature      — domain "billing", @smoke / @regression
 *   <root>/billing/invoice.feature       — domain "billing", @regression
 *   <root>/admin/users.feature           — domain "admin", @admin
 */
function mkTree() {
  const root = mkdtempSync(path.join(tmpdir(), 'qa-selection-'));
  mkdirSync(path.join(root, 'billing'), { recursive: true });
  mkdirSync(path.join(root, 'admin'), { recursive: true });

  writeFileSync(
    path.join(root, 'login.feature'),
    [
      'Feature: Login',
      '',
      '  @smoke',
      '  Scenario: Sign in with valid credentials',
      '    Given a registered user',
      '    When they sign in',
      '    Then the dashboard appears',
      '',
      '  @wip',
      '  Scenario: Sign in with SSO',
      '    Given an SSO user',
      '    When they sign in via the provider',
      '    Then the dashboard appears',
    ].join('\n'),
    'utf8',
  );

  writeFileSync(
    path.join(root, 'billing', 'checkout.feature'),
    [
      'Feature: Checkout',
      '',
      '  @smoke @regression',
      '  Scenario: Complete a purchase',
      '    Given a cart with one item',
      '    When the user checks out',
      '    Then a receipt is shown',
    ].join('\n'),
    'utf8',
  );

  writeFileSync(
    path.join(root, 'billing', 'invoice.feature'),
    [
      'Feature: Invoice',
      '',
      '  @regression',
      '  Scenario: Download an invoice',
      '    Given a completed order',
      '    When the user opens billing history',
      '    Then the invoice downloads',
    ].join('\n'),
    'utf8',
  );

  writeFileSync(
    path.join(root, 'admin', 'users.feature'),
    [
      'Feature: User administration',
      '',
      '  @admin',
      '  Scenario: Promote a user to admin',
      '    Given an admin operator',
      '    When they promote a user',
      '    Then the user has the admin role',
    ].join('\n'),
    'utf8',
  );

  return {
    root,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

describe('parseTagExpression — boolean grammar', () => {
  it('matches a single tag atom case-insensitively', () => {
    const pred = parseTagExpression('@Smoke');
    assert.equal(pred(new Set(['@smoke'])), true);
    assert.equal(pred(new Set(['@regression'])), false);
  });

  it('evaluates and / or / not with parentheses', () => {
    const pred = parseTagExpression('@smoke and not @wip');
    assert.equal(pred(new Set(['@smoke'])), true);
    assert.equal(pred(new Set(['@smoke', '@wip'])), false);

    const grouped = parseTagExpression('(@smoke or @regression) and not @wip');
    assert.equal(grouped(new Set(['@regression'])), true);
    assert.equal(grouped(new Set(['@regression', '@wip'])), false);
  });

  it('throws on a malformed expression', () => {
    assert.throws(() => parseTagExpression(''));
    assert.throws(() => parseTagExpression('@smoke and'));
    assert.throws(() => parseTagExpression('(@smoke'));
  });
});

describe('resolveSelection — feature id', () => {
  it('resolves a bare basename id to the matching .feature file', () => {
    const { root, cleanup } = mkTree();
    try {
      const res = resolveSelection({
        featureRoot: root,
        selector: { kind: 'feature', id: 'login' },
      });
      assert.equal(res.kind, 'feature');
      assert.equal(res.files.length, 1);
      assert.ok(res.files[0].endsWith(`login.feature`));
      assert.equal(res.scenarios.length, 2);
      assert.deepEqual(
        res.scenarios.map((s) => s.scenarioTitle),
        ['Sign in with valid credentials', 'Sign in with SSO'],
      );
    } finally {
      cleanup();
    }
  });

  it('resolves a featureRoot-relative path id (with or without extension)', () => {
    const { root, cleanup } = mkTree();
    try {
      const withExt = resolveSelection({
        featureRoot: root,
        selector: { kind: 'feature', id: 'billing/checkout.feature' },
      });
      const noExt = resolveSelection({
        featureRoot: root,
        selector: { kind: 'feature', id: 'billing/checkout' },
      });
      assert.equal(withExt.files.length, 1);
      assert.deepEqual(withExt.files, noExt.files);
      assert.ok(
        withExt.files[0].endsWith(path.join('billing', 'checkout.feature')),
      );
    } finally {
      cleanup();
    }
  });

  it('throws when no feature matches the id', () => {
    const { root, cleanup } = mkTree();
    try {
      assert.throws(
        () =>
          resolveSelection({
            featureRoot: root,
            selector: { kind: 'feature', id: 'nonexistent' },
          }),
        /no \.feature file matched/,
      );
    } finally {
      cleanup();
    }
  });
});

describe('resolveSelection — tag expression', () => {
  it('resolves a tag expression to the satisfying scenario set', () => {
    const { root, cleanup } = mkTree();
    try {
      const res = resolveSelection({
        featureRoot: root,
        selector: { kind: 'tag', expression: '@smoke and not @wip' },
      });
      assert.equal(res.kind, 'tag');
      // login "valid credentials" (@smoke) + checkout (@smoke @regression);
      // login SSO is @wip → excluded.
      const titles = res.scenarios.map((s) => s.scenarioTitle).sort();
      assert.deepEqual(titles, [
        'Complete a purchase',
        'Sign in with valid credentials',
      ]);
    } finally {
      cleanup();
    }
  });

  it('resolves a disjunction across domains', () => {
    const { root, cleanup } = mkTree();
    try {
      const res = resolveSelection({
        featureRoot: root,
        selector: { kind: 'tag', expression: '@admin or @wip' },
      });
      const titles = res.scenarios.map((s) => s.scenarioTitle).sort();
      assert.deepEqual(titles, ['Promote a user to admin', 'Sign in with SSO']);
      assert.equal(res.files.length, 2);
    } finally {
      cleanup();
    }
  });
});

describe('resolveSelection — domain', () => {
  it('resolves a domain to every scenario under that subdirectory', () => {
    const { root, cleanup } = mkTree();
    try {
      const res = resolveSelection({
        featureRoot: root,
        selector: { kind: 'domain', name: 'billing' },
      });
      assert.equal(res.kind, 'domain');
      assert.equal(res.files.length, 2);
      const titles = res.scenarios.map((s) => s.scenarioTitle).sort();
      assert.deepEqual(titles, ['Complete a purchase', 'Download an invoice']);
    } finally {
      cleanup();
    }
  });

  it('does not match a sibling domain that shares a prefix', () => {
    const { root, cleanup } = mkTree();
    try {
      mkdirSync(path.join(root, 'billing-archive'), { recursive: true });
      writeFileSync(
        path.join(root, 'billing-archive', 'old.feature'),
        [
          'Feature: Archive',
          '',
          '  Scenario: View archive',
          '    Then it shows',
        ].join('\n'),
        'utf8',
      );
      const res = resolveSelection({
        featureRoot: root,
        selector: { kind: 'domain', name: 'billing' },
      });
      // billing-archive must NOT be folded into the "billing" domain.
      assert.ok(res.files.every((f) => !f.includes('billing-archive')));
      assert.equal(res.files.length, 2);
    } finally {
      cleanup();
    }
  });

  it('throws when a domain has no scenarios', () => {
    const { root, cleanup } = mkTree();
    try {
      assert.throws(
        () =>
          resolveSelection({
            featureRoot: root,
            selector: { kind: 'domain', name: 'no-such-domain' },
          }),
        /no scenarios found under domain/,
      );
    } finally {
      cleanup();
    }
  });
});

describe('resolveSelection — guards', () => {
  it('throws on a missing featureRoot or selector', () => {
    assert.throws(() =>
      resolveSelection({ selector: { kind: 'tag', expression: '@x' } }),
    );
    assert.throws(() => resolveSelection({ featureRoot: '/tmp/x' }));
  });

  it('throws on an unknown selector kind', () => {
    assert.throws(
      () =>
        resolveSelection({
          featureRoot: '/tmp/x',
          selector: { kind: 'mystery' },
        }),
      /unknown selector kind/,
    );
  });
});
