// tests/scripts/epic-plan-decompose.2tier-creation-diagnostics.test.js
//
// Story #3120 / Task #3132 — contract coverage for the diagnostics.js
// phase helper under the 2-tier hierarchy (Epic #3078).
//
// Guarantee pinned here:
//
//   `reportPartialFailure` (diagnostics.js) emits no log line that
//   mentions "Tasks" when the Epic carries only Story
//   children. The 2-tier diagnostics surface must not surface a
//   "missing Tasks" warning — diagnostics is type-agnostic and
//   counts all child types together.
//
// Run: node --test tests/scripts/epic-plan-decompose.2tier-creation-diagnostics.test.js

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Logger } from '../../.agents/scripts/lib/Logger.js';
import { reportPartialFailure } from '../../.agents/scripts/lib/orchestration/epic-plan-decompose/phases/diagnostics.js';

const EPIC_ID = 9120;

describe('reportPartialFailure — 2-tier no "missing Tasks" warning (Story #3120)', () => {
  // Capture every Logger.error call without disturbing the singleton.
  function captureErrors() {
    const lines = [];
    const original = Logger.error;
    Logger.error = (msg) => {
      lines.push(String(msg));
    };
    return {
      lines,
      restore: () => {
        Logger.error = original;
      },
    };
  }

  it('does not emit any "Tasks" wording when the Epic has only Story children (2-tier)', async () => {
    const provider = {
      async getEpic() {
        return { id: EPIC_ID, labels: ['type::epic', 'agent::executing'] };
      },
      async getSubTickets() {
        // 2-tier: Stories only, no Feature or Task children.
        return [
          { id: 9121, title: 'S0', labels: ['type::story'], state: 'open' },
          { id: 9122, title: 'S1', labels: ['type::story'], state: 'open' },
        ];
      },
    };

    const cap = captureErrors();
    try {
      await reportPartialFailure({
        epicId: EPIC_ID,
        provider,
        err: new Error('decompose aborted mid-pass'),
      });
    } finally {
      cap.restore();
    }

    // The diagnostics surface must be 2-tier-clean: no warning that
    // implies Tasks should exist, no log line whose only purpose is to
    // observe the absence of Tasks.
    const taskMentions = cap.lines.filter((l) => /\btask(s)?\b/i.test(l));
    assert.deepEqual(
      taskMentions,
      [],
      `diagnostics emitted Task-mentioning lines under 2-tier:\n${taskMentions.join('\n')}`,
    );
    // The "to resume" hint is still emitted (cwd-hint contract).
    assert.ok(
      cap.lines.some((l) => /To resume/.test(l)),
      'reportPartialFailure must still emit the resume hint',
    );
    // The open-children count IS still emitted and reflects the 2 open
    // 2-tier children — proving the diagnostic surface is type-agnostic.
    assert.ok(
      cap.lines.some((l) => /Children currently open under Epic: 2/.test(l)),
      'reportPartialFailure must still report total open children',
    );
  });
});
