/**
 * tests/contract/planning/healthcheck-hierarchy-mode.test.js
 *
 * Contract: `epic-plan-healthcheck.js --paranoid` hierarchy validation
 * branches on `config.planning.hierarchy`.
 *
 * Story #3119 / Task #3130 (Epic #3078, Feature #3091). When the planner
 * config opts into 3-tier (`planning.hierarchy === '3-tier'`), the
 * post-plan healthcheck must accept an Epic that has Stories with inline
 * `## Acceptance` checklists and zero `type::task` children. The default
 * 4-tier branch must continue to require Tasks and continue to surface
 * the same "no type::task tickets" error on misconfiguration.
 *
 * Three cases:
 *   1. 3-tier mode + Stories with inline acceptance + zero Tasks → ok: true.
 *   2. 4-tier mode + Stories with child Tasks → ok: true (regression guard).
 *   3. 4-tier mode + Stories with zero Tasks → ok: false (preserves the
 *      existing "no type::task tickets" error).
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

function task(id) {
  return {
    id,
    title: `Task ${id}`,
    body: '## Goal\nimpl',
    labels: ['type::task'],
  };
}

/** Shared config skeleton — only the fields the healthcheck reads. */
function configWithHierarchy(hierarchy) {
  return {
    project: { baseBranch: 'main' },
    planning: { hierarchy },
    // Force checkConfig/git-remote off the critical path by not failing
    // them here — the config-validation check pulls from validateOrchestrationConfig
    // which only needs a minimally well-formed object.
    github: { owner: 'stub', repo: 'stub' },
  };
}

describe('epic-plan-healthcheck — hierarchy-mode branching (Story #3119)', () => {
  it('3-tier: passes when Stories carry inline acceptance and there are zero Tasks', async () => {
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
      injectedConfig: configWithHierarchy('3-tier'),
    });

    // Assert — the ticket-hierarchy check passes; degraded reflects the
    // aggregate (git-remote may fail in CI, so probe the targeted check).
    const hierarchyCheck = result.checks.find(
      (c) => c.name === 'ticket-hierarchy',
    );
    assert.ok(hierarchyCheck, 'ticket-hierarchy check must run under --paranoid');
    assert.equal(
      hierarchyCheck.ok,
      true,
      `expected ticket-hierarchy.ok=true, got detail="${hierarchyCheck.detail}"`,
    );
    assert.match(hierarchyCheck.detail, /3-tier/);
    assert.match(hierarchyCheck.detail, /inline acceptance/);
  });

  it('3-tier: fails when any Story is missing its inline acceptance section', async () => {
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
      injectedConfig: configWithHierarchy('3-tier'),
    });

    // Assert
    const hierarchyCheck = result.checks.find(
      (c) => c.name === 'ticket-hierarchy',
    );
    assert.equal(hierarchyCheck.ok, false);
    assert.match(hierarchyCheck.detail, /missing inline acceptance/);
    assert.match(hierarchyCheck.detail, /#202/);
  });

  it('4-tier (default): passes when Stories have child Tasks (no regression)', async () => {
    // Arrange
    const tickets = [
      feature(300),
      storyWithInlineAcceptance(301),
      task(302),
      task(303),
    ];
    const provider = buildStubProvider(tickets);

    // Act
    const result = await runPlanHealthcheck({
      epicId: EPIC_ID,
      paranoid: true,
      injectedProvider: provider,
      injectedConfig: configWithHierarchy('4-tier'),
    });

    // Assert
    const hierarchyCheck = result.checks.find(
      (c) => c.name === 'ticket-hierarchy',
    );
    assert.equal(
      hierarchyCheck.ok,
      true,
      `expected ticket-hierarchy.ok=true, got detail="${hierarchyCheck.detail}"`,
    );
    assert.match(hierarchyCheck.detail, /1 features/);
    assert.match(hierarchyCheck.detail, /2 tasks/);
  });

  it('4-tier (default): fails with the existing "no type::task tickets" error when Stories have zero Tasks', async () => {
    // Arrange — same misconfigured backlog that 3-tier accepts; under 4-tier
    // it must still fail with the preserved error string.
    const tickets = [
      feature(400),
      storyWithInlineAcceptance(401),
      storyWithInlineAcceptance(402),
    ];
    const provider = buildStubProvider(tickets);

    // Act
    const result = await runPlanHealthcheck({
      epicId: EPIC_ID,
      paranoid: true,
      injectedProvider: provider,
      injectedConfig: configWithHierarchy('4-tier'),
    });

    // Assert
    const hierarchyCheck = result.checks.find(
      (c) => c.name === 'ticket-hierarchy',
    );
    assert.equal(hierarchyCheck.ok, false);
    assert.match(hierarchyCheck.detail, /no type::task tickets/);
  });
});
