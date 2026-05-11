/**
 * Unit tests for `appendChecksSection` — Story #1290 (Epic #1143).
 *
 * The helper renders self-healing-check findings into the retro body and
 * suppresses the section when findings are empty so the compact
 * "🟢 Clean sprint" shape is preserved.
 *
 * Coverage:
 *   - Empty findings → body returned unchanged.
 *   - Non-empty findings → section rendered with id/severity/summary/fixCommand.
 *   - Section is inserted **before** the `<!-- retro-complete: ... -->` marker.
 *   - fixCommand format mirrors /diagnose (literal shell command, fenced).
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { appendChecksSection } from '../../../.agents/scripts/lib/orchestration/retro-runner.js';

const RETRO_MARKER = '<!-- retro-complete: 2026-05-11T00:00:00.000Z -->';

function makeRetroBody(extraBefore = '') {
  return [
    '## 🪞 Sprint Retrospective — Epic #1143',
    '',
    '_Generated 2026-05-11T00:00:00.000Z_',
    '',
    extraBefore,
    RETRO_MARKER,
  ]
    .filter(Boolean)
    .join('\n');
}

test('appendChecksSection: empty findings array returns body unchanged', () => {
  const body = makeRetroBody('### Sprint Scorecard\n');
  assert.equal(appendChecksSection(body, []), body);
});

test('appendChecksSection: non-array findings (undefined/null) returns body unchanged', () => {
  const body = makeRetroBody('### Sprint Scorecard\n');
  assert.equal(appendChecksSection(body, undefined), body);
  assert.equal(appendChecksSection(body, null), body);
});

test('appendChecksSection: single finding renders id/severity/summary/fixCommand', () => {
  const body = makeRetroBody('### Sprint Scorecard\n');
  const finding = {
    id: 'orphan-worktree-biome',
    severity: 'warning',
    scope: 'retro',
    summary: 'orphan worktree contains a nested biome.json',
    fixCommand: 'rm -rf .worktrees/story-1290',
    autoCorrectable: false,
  };
  const out = appendChecksSection(body, [finding]);
  assert.match(out, /### Self-Healing Checks/);
  assert.match(out, /orphan-worktree-biome/);
  assert.match(out, /warning/);
  assert.match(out, /orphan worktree contains a nested biome\.json/);
  assert.match(out, /`rm -rf \.worktrees\/story-1290`/);
});

test('appendChecksSection: section is inserted BEFORE the retro-complete marker', () => {
  const body = makeRetroBody('### Sprint Scorecard\n');
  const finding = {
    id: 'baseline-drift',
    severity: 'blocker',
    summary: 'main checkout drifted from baseline',
    fixCommand: 'npm run lint',
  };
  const out = appendChecksSection(body, [finding]);
  const idxSection = out.indexOf('### Self-Healing Checks');
  const idxMarker = out.indexOf(RETRO_MARKER);
  assert.ok(idxSection > 0, 'section should be present');
  assert.ok(idxMarker > 0, 'retro-complete marker should still be present');
  assert.ok(
    idxSection < idxMarker,
    'section must be inserted BEFORE the retro-complete marker',
  );
  // The marker must remain at the end of the body (EOF sentinel).
  assert.ok(out.trimEnd().endsWith(RETRO_MARKER));
});

test('appendChecksSection: multiple findings render as separate table rows', () => {
  const body = makeRetroBody('### Sprint Scorecard\n');
  const findings = [
    {
      id: 'check-a',
      severity: 'warning',
      summary: 'first finding',
      fixCommand: 'npm run lint:fix',
    },
    {
      id: 'check-b',
      severity: 'info',
      summary: 'second finding',
      fixCommand: 'npm test',
    },
  ];
  const out = appendChecksSection(body, findings);
  assert.match(
    out,
    /\| check-a \| warning \| first finding \| `npm run lint:fix` \|/,
  );
  assert.match(out, /\| check-b \| info \| second finding \| `npm test` \|/);
});

test('appendChecksSection: pipes in field values are escaped', () => {
  const body = makeRetroBody('### Sprint Scorecard\n');
  const finding = {
    id: 'pipe-test',
    severity: 'info',
    summary: 'a | piped summary',
    fixCommand: 'echo a | grep b',
  };
  const out = appendChecksSection(body, [finding]);
  // Backslash-escaped pipes inside the cells so the markdown table parser
  // does not see them as column separators.
  assert.match(out, /a \\\| piped summary/);
  assert.match(out, /echo a \\\| grep b/);
});

test('appendChecksSection: missing retro-complete marker still appends section (defensive)', () => {
  const body = '## 🪞 Sprint Retrospective\n\n_no marker here_';
  const finding = {
    id: 'x',
    severity: 'info',
    summary: 's',
    fixCommand: 'cmd',
  };
  const out = appendChecksSection(body, [finding]);
  assert.match(out, /### Self-Healing Checks/);
  assert.ok(out.startsWith(body));
});
