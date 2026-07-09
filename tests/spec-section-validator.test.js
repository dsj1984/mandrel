/**
 * tests/spec-section-validator.test.js — unit tests for the Tech Spec
 * post-authoring section gate.
 *
 * Covers (per Story #3853 acceptance):
 *  - `## Delivery Slicing` present (canonical) → ok
 *  - variant casing `## Delivery slicing` → ok
 *  - variant casing `## DELIVERY SLICING` → ok
 *  - shorthand `## Slicing` → ok
 *  - heading absent → not ok, missing names the section
 *  - empty / non-string body → not ok
 *  - inline mention (not a heading) → not ok (heading required)
 *  - validateSpecFile reads from disk and reports the same verdict
 *  - formatMissingSectionMessage names the section and the recovery options
 *
 * Story #4403 (Finding 3): the standalone `epic-plan-spec-validate.js` CLI
 * (and its separate Phase 7.5 workflow step) is retired — `validateSpecFile`
 * and `formatMissingSectionMessage` now live on this retained library, and
 * `runSpecPhase` calls `validateSpecSections` directly as part of its
 * persist-path input validation (see
 * `tests/epic-plan-spec-risk-verdict.test.js` for the fail-closed
 * before-any-GitHub-call coverage).
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
  formatMissingSectionMessage,
  REQUIRED_SECTION_NAMES,
  validateSpecFile,
  validateSpecSections,
} from '../.agents/scripts/lib/orchestration/spec-section-validator.js';

const SPEC_WITH_SLICING = `# Tech Spec

## Core Components

| Component | Responsibility |
| --------- | -------------- |
| Foo       | does X         |

## Delivery Slicing

- Slice 1 — capability A (the auth boundary).
- Slice 2 — capability B (the billing boundary).
`;

describe('validateSpecSections — Delivery Slicing heading detection', () => {
  it('returns ok when the canonical heading is present', () => {
    const result = validateSpecSections({ body: SPEC_WITH_SLICING });
    assert.equal(result.ok, true);
    assert.deepEqual(result.missing, []);
    assert.deepEqual(result.present, ['Delivery Slicing']);
  });

  it('accepts variant casing `## Delivery slicing`', () => {
    const body = '# Spec\n\n## Delivery slicing\n\n- Slice the work.\n';
    const result = validateSpecSections({ body });
    assert.equal(result.ok, true);
    assert.deepEqual(result.missing, []);
  });

  it('accepts variant casing `## DELIVERY SLICING`', () => {
    const body = '# Spec\n\n## DELIVERY SLICING\n\n- Slice the work.\n';
    const result = validateSpecSections({ body });
    assert.equal(result.ok, true);
    assert.deepEqual(result.missing, []);
  });

  it('accepts the `## Slicing` shorthand', () => {
    const body = '# Spec\n\n## Slicing\n\n- Slice the work.\n';
    const result = validateSpecSections({ body });
    assert.equal(result.ok, true);
    assert.deepEqual(result.missing, []);
  });

  it('reports missing when no Delivery Slicing heading is present', () => {
    const body = '# Spec\n\n## Core Components\n\nA table only, no slicing.\n';
    const result = validateSpecSections({ body });
    assert.equal(result.ok, false);
    assert.deepEqual(result.missing, ['Delivery Slicing']);
    assert.deepEqual(result.present, []);
  });

  it('does not match an inline (non-heading) mention of delivery slicing', () => {
    const body =
      '# Spec\n\nThe delivery slicing approach is described below but never as a heading.\n';
    const result = validateSpecSections({ body });
    assert.equal(result.ok, false);
    assert.deepEqual(result.missing, ['Delivery Slicing']);
  });

  it('does not match a level-3 (`### `) heading', () => {
    const body = '# Spec\n\n### Delivery Slicing\n\nWrong heading level.\n';
    const result = validateSpecSections({ body });
    assert.equal(result.ok, false);
    assert.deepEqual(result.missing, ['Delivery Slicing']);
  });

  it('treats an empty body as missing', () => {
    const result = validateSpecSections({ body: '' });
    assert.equal(result.ok, false);
    assert.deepEqual(result.missing, ['Delivery Slicing']);
  });

  it('treats a non-string / absent body as missing without throwing', () => {
    assert.equal(validateSpecSections({}).ok, false);
    assert.equal(validateSpecSections().ok, false);
    assert.equal(validateSpecSections({ body: null }).ok, false);
  });

  it('exports the required section names list', () => {
    assert.deepEqual(REQUIRED_SECTION_NAMES, ['Delivery Slicing']);
  });
});

describe('formatMissingSectionMessage', () => {
  it('names the missing section and the spec path', () => {
    const msg = formatMissingSectionMessage({
      techspecPath: 'temp/epic-18/techspec.md',
      missing: ['Delivery Slicing'],
    });
    assert.match(msg, /## Delivery Slicing/);
    assert.match(msg, /temp\/epic-18\/techspec\.md/);
  });

  it('tells the operator to re-author or add the section manually', () => {
    const msg = formatMissingSectionMessage({
      techspecPath: 'spec.md',
      missing: ['Delivery Slicing'],
    });
    assert.match(msg, /[Rr]e-author/);
    assert.match(msg, /by hand|manually/);
  });
});

describe('validateSpecFile — reads from disk', () => {
  let dir;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'spec-section-validator-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns ok for a file containing the heading', async () => {
    const path = join(dir, 'techspec.md');
    await writeFile(path, SPEC_WITH_SLICING, 'utf8');
    const result = await validateSpecFile({ techspecPath: path });
    assert.equal(result.ok, true);
  });

  it('returns not-ok for a file missing the heading', async () => {
    const path = join(dir, 'techspec.md');
    await writeFile(
      path,
      '# Spec\n\n## Core Components\n\nNo slicing.\n',
      'utf8',
    );
    const result = await validateSpecFile({ techspecPath: path });
    assert.equal(result.ok, false);
    assert.deepEqual(result.missing, ['Delivery Slicing']);
  });
});
