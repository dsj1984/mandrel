import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  classifyFinding,
  FINDING_CLASSES,
  FOCUS_LABELS,
} from '../../../.agents/scripts/lib/findings/classify-finding.js';
import { META_LABELS } from '../../../.agents/scripts/lib/label-constants.js';

test('classifyFinding maps a finding to exactly one class from the enum', () => {
  for (const cls of FINDING_CLASSES) {
    const result = classifyFinding({ class: cls });
    assert.equal(result.class, cls);
    assert.ok(
      FINDING_CLASSES.includes(result.class),
      `${result.class} must be one of the enum classes`,
    );
  }
});

test('classifyFinding returns a non-empty label set for every class', () => {
  for (const cls of FINDING_CLASSES) {
    const { labels } = classifyFinding({ class: cls });
    assert.ok(Array.isArray(labels));
    assert.ok(labels.length >= 1, `${cls} must route to at least one label`);
  }
});

test('a tooling-dx classification routes to focus::scripts and meta::framework-gap', () => {
  const { class: cls, labels } = classifyFinding({ class: 'tooling-dx' });
  assert.equal(cls, 'tooling-dx');
  assert.deepEqual(labels, [FOCUS_LABELS.SCRIPTS, META_LABELS.FRAMEWORK_GAP]);
  assert.ok(labels.includes('focus::scripts'));
  assert.ok(labels.includes('meta::framework-gap'));
});

test('product-bug routes to focus::product only', () => {
  const { labels } = classifyFinding({ class: 'product-bug' });
  assert.deepEqual(labels, [FOCUS_LABELS.PRODUCT]);
});

test('environment-setup routes to focus::environment only', () => {
  const { labels } = classifyFinding({ class: 'environment-setup' });
  assert.deepEqual(labels, [FOCUS_LABELS.ENVIRONMENT]);
});

test('test-gap routes to focus::tests only', () => {
  const { labels } = classifyFinding({ class: 'test-gap' });
  assert.deepEqual(labels, [FOCUS_LABELS.TESTS]);
});

test('enhancement routes to focus::enhancement and meta::consumer-improvement', () => {
  const { labels } = classifyFinding({ class: 'enhancement' });
  assert.deepEqual(labels, [
    FOCUS_LABELS.ENHANCEMENT,
    META_LABELS.CONSUMER_IMPROVEMENT,
  ]);
});

test('classifyFinding trims surrounding whitespace on the class', () => {
  const { class: cls, labels } = classifyFinding({ class: '  tooling-dx  ' });
  assert.equal(cls, 'tooling-dx');
  assert.deepEqual(labels, [FOCUS_LABELS.SCRIPTS, META_LABELS.FRAMEWORK_GAP]);
});

test('an unknown class is rejected rather than silently defaulted', () => {
  assert.throws(
    () => classifyFinding({ class: 'not-a-real-class' }),
    RangeError,
  );
});

test('an empty-string class is rejected', () => {
  assert.throws(() => classifyFinding({ class: '' }), RangeError);
});

test('a whitespace-only class is rejected', () => {
  assert.throws(() => classifyFinding({ class: '   ' }), RangeError);
});

test('a missing class field is rejected', () => {
  assert.throws(() => classifyFinding({}), RangeError);
});

test('a non-string class is rejected', () => {
  assert.throws(() => classifyFinding({ class: 42 }), RangeError);
});

test('a non-object finding is rejected with a TypeError', () => {
  assert.throws(() => classifyFinding(null), TypeError);
  assert.throws(() => classifyFinding(undefined), TypeError);
  assert.throws(() => classifyFinding('product-bug'), TypeError);
});

test('the returned labels array is a copy and cannot mutate the routing table', () => {
  const first = classifyFinding({ class: 'tooling-dx' });
  first.labels.push('focus::injected');
  const second = classifyFinding({ class: 'tooling-dx' });
  assert.deepEqual(second.labels, [
    FOCUS_LABELS.SCRIPTS,
    META_LABELS.FRAMEWORK_GAP,
  ]);
});
