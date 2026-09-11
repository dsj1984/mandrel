/**
 * Unit tests for the `audit-labels` footer vocabulary (Story #5307).
 *
 * The dedup corpus is listed by `audit::*` label, so this footer is how a
 * finding's lens labels reach the Story the chained planning path files. It
 * sits beside the fingerprint and semantic-key footers and round-trips the
 * same way.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { auditLabelFooter, parseAuditLabelFooter } from '../route-finding.js';

test('renders a sorted, de-duplicated comma-joined footer', () => {
  const footer = auditLabelFooter([
    'audit::performance',
    'audit::architecture',
    'audit::performance',
  ]);
  assert.equal(
    footer,
    '<!-- audit-labels: audit::architecture,audit::performance -->',
  );
});

test('accepts a single label as a bare string', () => {
  assert.equal(
    auditLabelFooter('audit::clean-code'),
    '<!-- audit-labels: audit::clean-code -->',
  );
});

test('drops anything that is not an audit:: label', () => {
  // A label the taxonomy never defined must never reach a Story — the junk
  // derivation Story #4195 closed, held shut here too.
  assert.equal(auditLabelFooter(['junk', 'type::story', 42, null]), '');
  assert.equal(
    auditLabelFooter(['junk', 'audit::devops']),
    '<!-- audit-labels: audit::devops -->',
  );
});

test('renders nothing for an empty set', () => {
  assert.equal(auditLabelFooter([]), '');
});

test('round-trips through the parser', () => {
  const footer = auditLabelFooter(['audit::seo', 'audit::privacy']);
  assert.deepEqual(parseAuditLabelFooter(`intro\n${footer}\noutro`), [
    'audit::privacy',
    'audit::seo',
  ]);
});

test('parses every footer in a body and de-duplicates across them', () => {
  const body = [
    auditLabelFooter(['audit::seo']),
    'text between',
    auditLabelFooter(['audit::seo', 'audit::mobile']),
  ].join('\n');
  assert.deepEqual(parseAuditLabelFooter(body).sort(), [
    'audit::mobile',
    'audit::seo',
  ]);
});

test('returns nothing for a body carrying no footer', () => {
  assert.deepEqual(parseAuditLabelFooter('no footers here'), []);
});
