/**
 * Pins the verification-discipline wording (Story #5863) in the on-demand
 * testing, API and audit docs so a later edit cannot silently drop it.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);

function read(relPath) {
  return readFileSync(path.join(REPO_ROOT, relPath), 'utf8');
}

function section(body, startPattern, endPattern) {
  const start = body.search(startPattern);
  assert.ok(start >= 0, `section ${startPattern} not found`);
  const rest = body.slice(start);
  const end = rest.slice(1).search(endPattern);
  return end < 0 ? rest : rest.slice(0, end + 1);
}

describe('testing-standards verification discipline', () => {
  const body = read('.agents/rules/testing-standards.md');

  it('requires a stated behaviour delta covered by the regression test', () => {
    const applying = section(body, /^## Applying the Standards/m, /^## /m);
    assert.match(applying, /`Behaviour delta:`/);
    assert.match(applying, /just outside it is asserted unchanged/);
  });

  it('directs invariant-bearing units to property tests with a failure witness', () => {
    const unit = section(body, /^### Unit — pure logic/m, /^### /m);
    assert.match(unit, /\*\*Property tests\.\*\*/);
    assert.match(unit, /`fast-check` for\s+JS\/TS/);
    assert.match(unit, /\*\*Failure witness\.\*\*/);
    assert.match(unit, /`Failure witness:`/);
  });
});

describe('api-conventions caller obligations', () => {
  it('carries the caller-obligations checklist item', () => {
    const checklist = section(
      read('.agents/rules/api-conventions.md'),
      /^## Authoring Checklist/m,
      /^## /m,
    );
    assert.match(checklist, /caller obligations/);
    assert.match(checklist, /negative test\s+for each obligation/);
  });
});

describe('audit-quality vacuous property tests', () => {
  it('flags vacuous property tests under dimension 8', () => {
    const dim8 = section(
      read('.agents/workflows/audit-quality.md'),
      /^8\. \*\*Property-Based Coverage/m,
      /^## /m,
    );
    assert.match(dim8, /\*\*Vacuous property tests\.\*\*/);
  });
});
