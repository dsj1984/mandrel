/**
 * v2 Stage 3 planning-fork cutover guards.
 *
 * The deleted `helpers/plan-epic.md` workflow used to host fresh-context
 * planning critics. Stage 3 collapses `/plan` to one `plan.md` path and
 * removes that fork. These structural assertions make sure the old critic
 * dispatch surface does not reappear through stale prose while the single
 * deterministic persist gate remains documented.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

const planSource = readFileSync(
  path.join(REPO_ROOT, '.agents', 'workflows', 'plan.md'),
  'utf8',
);

function section(headingPattern) {
  return (
    planSource.match(
      new RegExp(`${headingPattern}[\\s\\S]*?(?=\\n#{2,3} )`),
    )?.[0] ?? ''
  );
}

describe('/plan critic workflow cutover — retired helper surface', () => {
  it('uses plan.md as the sole planning workflow source', () => {
    assert.match(planSource, /Single planning path/i);
    assert.match(planSource, /no\s*\n?Epic\/Story router/i);
  });

  it('does not reference deleted planning-fork helper files', () => {
    for (const deleted of [
      'helpers/plan-epic.md',
      'helpers/plan-story.md',
      'helpers/scope-triage-gate.md',
      'helpers/plan-epic-reference.md',
    ]) {
      assert.doesNotMatch(planSource, new RegExp(deleted.replace('.', '\\.')));
    }
  });

  it('does not wire the retired fresh-context critic sub-agent section', () => {
    assert.doesNotMatch(planSource, /Conditional critics/i);
    assert.doesNotMatch(planSource, /fresh-context sub-agents/i);
    assert.doesNotMatch(planSource, /epic-plan-premortem/);
    assert.doesNotMatch(planSource, /epic-plan-consolidate/);
    assert.doesNotMatch(planSource, /plan-critics\.js/);
  });
});

describe('/plan critic workflow cutover — deterministic persist gate remains', () => {
  const author = section('### 2\\. Author');
  const persist = section('### 3\\. Persist');

  it('keeps authoring on stories.json and the default-single split policy', () => {
    assert.ok(author, 'plan.md must carry the author step');
    assert.match(author, /`stories\.json`/);
    assert.match(author, /\*\*length 1 by default\*\*/i);
    assert.match(author, /Split only under the\s*\n?policy above/i);
  });

  it('keeps risk review at gate #2 before plan-persist writes', () => {
    assert.ok(persist, 'plan.md must carry the persist step');
    assert.match(persist, /\*\*Gate #2\*\*/);
    assert.match(persist, /risk routing requires review/i);
    assert.match(persist, /before\s*\n?persist/i);
    assert.match(persist, /node \.agents\/scripts\/plan-persist\.js/);
  });

  it('keeps deterministic gates fail-closed under --yes', () => {
    assert.match(
      planSource,
      /Deterministic gates[\s\S]*still fail closed under `--yes`/i,
    );
  });
});
