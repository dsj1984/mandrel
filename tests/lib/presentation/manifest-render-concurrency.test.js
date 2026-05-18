import assert from 'node:assert/strict';
import test from 'node:test';

import { renderConcurrencyHazards } from '../../../.agents/scripts/lib/presentation/manifest-render-waves.js';

/**
 * Story #2297 — `renderConcurrencyHazards` produces the manifest tail
 * block listing cross-Story path conflicts (Story #2296 findings). The
 * empty-findings case must still render an explicit "no hazards detected"
 * confirmation so dry-run consumers can read the absence as a signal,
 * not a silent drop.
 */

test('renders shared-editor + implicit-cross-story-dep findings together', () => {
  const out = renderConcurrencyHazards([
    {
      kind: 'shared-editor',
      path: '.github/workflows/quality.yml',
      storySlugs: ['s-a', 's-b'],
      severity: 'soft',
    },
    {
      kind: 'implicit-cross-story-dep',
      path: '.agents/schemas/baselines/coverage.schema.json',
      producer: { storySlug: 's-prod', taskSlug: 't-prod' },
      consumer: {
        storySlug: 's-cons',
        taskSlug: 't-cons',
        sourceField: 'verify',
      },
      severity: 'soft',
    },
  ]);
  assert.match(out, /## ⚠️ Concurrency Hazards/);
  assert.match(out, /\.github\/workflows\/quality\.yml/);
  assert.match(out, /s-a/);
  assert.match(out, /s-b/);
  assert.match(out, /produced by Story `s-prod`/);
  assert.match(out, /consumed by Story `s-cons`/);
});

test('renders the empty-findings confirmation', () => {
  const out = renderConcurrencyHazards([]);
  assert.match(out, /## ⚠️ Concurrency Hazards/);
  assert.match(out, /✓ No concurrency hazards detected\./);
});

test('flags hard-severity findings as blocking inline', () => {
  const out = renderConcurrencyHazards([
    {
      kind: 'shared-editor',
      path: 'package.json',
      storySlugs: ['s-a', 's-b', 's-c'],
      severity: 'hard',
    },
  ]);
  assert.match(out, /\*\*\(blocking\)\*\*/);
});

test('returns empty string on non-array input', () => {
  assert.equal(renderConcurrencyHazards(null), '');
  assert.equal(renderConcurrencyHazards(undefined), '');
  assert.equal(renderConcurrencyHazards('nope'), '');
});

test('sorts findings within each kind by path for stable output', () => {
  const out = renderConcurrencyHazards([
    {
      kind: 'shared-editor',
      path: 'z-second.yml',
      storySlugs: ['s-a', 's-b'],
      severity: 'soft',
    },
    {
      kind: 'shared-editor',
      path: 'a-first.yml',
      storySlugs: ['s-c', 's-d'],
      severity: 'soft',
    },
  ]);
  const firstIdx = out.indexOf('a-first.yml');
  const secondIdx = out.indexOf('z-second.yml');
  assert.ok(firstIdx > 0 && firstIdx < secondIdx);
});
