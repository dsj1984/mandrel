/**
 * tests/lib/orchestration/soft-findings.test.js — the persist soft-finding
 * surface (`soft-findings.js`, the survivor of the retired fan-out gate,
 * Story #5312).
 *
 * Every finding is advisory now, and the surface still announces a
 * cross-Story conflict as a conflict and a single-Story nudge as an advisory,
 * so the operator reads each under the kind it is.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Logger } from '../../../.agents/scripts/lib/Logger.js';
import { surfaceSoftConflictFindings } from '../../../.agents/scripts/lib/orchestration/plan-persist/soft-findings.js';

function captureWarnings(t) {
  const lines = [];
  t.mock.method(Logger, 'warn', (msg) => {
    lines.push(String(msg));
  });
  return lines;
}

const sharedEditor = {
  kind: 'shared-editor',
  severity: 'soft',
  path: 'lib/x.js',
  storySlugs: ['a', 'b'],
};

const advisory = {
  kind: 'open-question',
  severity: 'soft',
  message: 'Body text carries an open question.',
};

describe('surfaceSoftConflictFindings', () => {
  it('announces conflicts as conflicts and other soft kinds as advisories', (t) => {
    const lines = captureWarnings(t);
    surfaceSoftConflictFindings([sharedEditor, advisory], 'unit');
    assert.match(lines[0], /\[unit\] 1 soft cross-Story conflict finding\(s\)/);
    assert.match(
      lines[1],
      /\[unit\] soft conflict: Shared-editor conflict: "lib\/x\.js"/,
    );
    assert.match(
      lines[2],
      /\[unit\] 1 advisory finding\(s\) — the persist proceeds/,
    );
    assert.match(
      lines[3],
      /\[unit\] advisory \(open-question\): Body text carries/,
    );
    assert.equal(lines.length, 4);
  });

  it('says nothing when there is no soft finding', (t) => {
    const lines = captureWarnings(t);
    surfaceSoftConflictFindings([{ ...sharedEditor, severity: 'hard' }]);
    surfaceSoftConflictFindings([]);
    surfaceSoftConflictFindings(undefined);
    assert.deepEqual(lines, []);
  });

  it('defaults the tag to plan-persist and skips a malformed entry', (t) => {
    const lines = captureWarnings(t);
    surfaceSoftConflictFindings([advisory, null, 'nope']);
    assert.match(lines[0], /^\[plan-persist\] 1 advisory finding/);
    assert.equal(lines.length, 2);
  });
});
