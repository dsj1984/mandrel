/**
 * tests/contract/planning/healthcheck-hierarchy-mode.test.js
 *
 * Contract: `epic-plan-healthcheck.js --paranoid` hierarchy validation.
 *
 * Task #3154 (Epic #3078) deleted the `planning.hierarchy` flag and
 * collapsed every reader to 3-tier-only. The post-plan healthcheck now
 * accepts an Epic when every Story carries an inline `## Acceptance`
 * checklist and rejects it when any Story is missing one. There is no
 * 4-tier branch to exercise.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { runPlanHealthcheck } from '../../../.agents/scripts/epic-plan-healthcheck.js';

const EPIC_ID = 3078;

/**
 * Minimal stub provider that satisfies the surface area the healthcheck
 * touches (`getSubTickets`). The healthcheck never mutates tickets, so we
 * only need the read path.
 */
function buildStubProvider(tickets) {
  return {
    async getSubTickets() {
      return tickets;
    },
  };
}

function feature(id) {
  return {
    id,
    title: `Feature ${id}`,
    body: 'feature body',
    labels: ['type::feature'],
  };
}

function storyWithInlineAcceptance(id) {
  return {
    id,
    title: `Story ${id}`,
    body: [
      '## Goal',
      'Do the thing.',
      '',
      '## Acceptance',
      '- [ ] First criterion',
      '- [ ] Second criterion',
      '',
      '## Verify',
      '- npm test',
    ].join('\n'),
    labels: ['type::story', 'complexity::M'],
  };
}

function storyWithoutAcceptance(id) {
  return {
    id,
    title: `Story ${id}`,
    body: '## Goal\nDo the thing.\n',
    labels: ['type::story', 'complexity::M'],
  };
}

/** Shared config skeleton — only the fields the healthcheck reads. */
function minimalConfig() {
  return {
    project: { baseBranch: 'main' },
    planning: {},
    github: { owner: 'stub', repo: 'stub' },
  };
}

describe('epic-plan-healthcheck — 3-tier-only hierarchy validation (Task #3154)', () => {
  it('passes when Stories carry inline acceptance', async () => {
    // Arrange
    const tickets = [
      feature(100),
      storyWithInlineAcceptance(101),
      storyWithInlineAcceptance(102),
    ];
    const provider = buildStubProvider(tickets);

    // Act
    const result = await runPlanHealthcheck({
      epicId: EPIC_ID,
      paranoid: true,
      injectedProvider: provider,
      injectedConfig: minimalConfig(),
    });

    // Assert — the ticket-hierarchy check passes; degraded reflects the
    // aggregate (git-remote may fail in CI, so probe the targeted check).
    const hierarchyCheck = result.checks.find(
      (c) => c.name === 'ticket-hierarchy',
    );
    assert.ok(
      hierarchyCheck,
      'ticket-hierarchy check must run under --paranoid',
    );
    assert.equal(
      hierarchyCheck.ok,
      true,
      `expected ticket-hierarchy.ok=true, got detail="${hierarchyCheck.detail}"`,
    );
    assert.match(hierarchyCheck.detail, /3-tier/);
    assert.match(hierarchyCheck.detail, /inline acceptance/);
  });

  it('fails when any Story is missing its inline acceptance section', async () => {
    // Arrange
    const tickets = [
      feature(200),
      storyWithInlineAcceptance(201),
      storyWithoutAcceptance(202),
    ];
    const provider = buildStubProvider(tickets);

    // Act
    const result = await runPlanHealthcheck({
      epicId: EPIC_ID,
      paranoid: true,
      injectedProvider: provider,
      injectedConfig: minimalConfig(),
    });

    // Assert
    const hierarchyCheck = result.checks.find(
      (c) => c.name === 'ticket-hierarchy',
    );
    assert.equal(hierarchyCheck.ok, false);
    assert.match(hierarchyCheck.detail, /missing inline acceptance/);
    assert.match(hierarchyCheck.detail, /#202/);
  });
});
