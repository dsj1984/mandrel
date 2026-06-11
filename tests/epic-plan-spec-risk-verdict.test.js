/**
 * tests/epic-plan-spec-risk-verdict.test.js — Story #3873 (Epic #3865).
 *
 * Contract tests for the planner-authored, schema-validated risk verdict
 * that replaced the keyword-regex risk classifier (hard cutover):
 *
 *   - `risk-verdict.schema.json` rejects an out-of-vocabulary axis and a
 *     missing rationale; a malformed verdict surfaces a validation error
 *     (fails closed) rather than mis-routing the review gate.
 *   - `loadRiskVerdict` fails closed on a missing or non-JSON file.
 *   - `runSpecPhase` records the verdict as a `risk-verdict` structured
 *     comment on the Epic and in the `epic-plan-state` checkpoint
 *     (`riskVerdict` field), with the derived planningRisk envelope.
 *   - A missing verdict fails the spec phase before any GitHub mutation.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
  loadRiskVerdict,
  runSpecPhase,
  validateRiskVerdict,
} from '../.agents/scripts/epic-plan-spec.js';

const VALID_VERDICT = {
  axes: [
    {
      axis: 'critical-workflow',
      level: 'high',
      rationale: 'Rewrites the /plan gate routing path.',
    },
  ],
  summary: 'High-risk planning-gate change.',
};

let sandbox;

beforeEach(() => {
  sandbox = mkdtempSync(path.join(os.tmpdir(), 'risk-verdict-'));
});

afterEach(() => {
  if (sandbox) rmSync(sandbox, { recursive: true, force: true });
});

describe('risk-verdict schema validation (fails closed)', () => {
  it('accepts a vocabulary-conformant verdict', () => {
    assert.doesNotThrow(() => validateRiskVerdict(VALID_VERDICT));
  });

  it('rejects an out-of-vocabulary axis', () => {
    const verdict = {
      axes: [
        {
          axis: 'vibes',
          level: 'high',
          rationale: 'Not a recognized axis.',
        },
      ],
      summary: 'Out-of-vocabulary axis.',
    };
    assert.throws(
      () => validateRiskVerdict(verdict),
      /failed schema validation/,
    );
  });

  it('rejects a missing rationale', () => {
    const verdict = {
      axes: [{ axis: 'security', level: 'high' }],
      summary: 'Rationale omitted.',
    };
    assert.throws(
      () => validateRiskVerdict(verdict),
      /failed schema validation/,
    );
  });

  it('rejects an empty rationale and an unknown level', () => {
    assert.throws(
      () =>
        validateRiskVerdict({
          axes: [{ axis: 'security', level: 'high', rationale: '' }],
          summary: 's',
        }),
      /failed schema validation/,
    );
    assert.throws(
      () =>
        validateRiskVerdict({
          axes: [{ axis: 'security', level: 'extreme', rationale: 'x' }],
          summary: 's',
        }),
      /failed schema validation/,
    );
  });

  it('rejects a verdict missing the summary', () => {
    assert.throws(
      () => validateRiskVerdict({ axes: [] }),
      /failed schema validation/,
    );
  });

  it('loadRiskVerdict fails closed on a missing file', () => {
    assert.throws(
      () => loadRiskVerdict(path.join(sandbox, 'absent.json')),
      /cannot read risk verdict/,
    );
  });

  it('loadRiskVerdict fails closed on non-JSON content', () => {
    const verdictPath = path.join(sandbox, 'broken.json');
    writeFileSync(verdictPath, 'not json at all', 'utf8');
    assert.throws(() => loadRiskVerdict(verdictPath), /not valid JSON/);
  });

  it('loadRiskVerdict round-trips a valid verdict file', () => {
    const verdictPath = path.join(sandbox, 'verdict.json');
    writeFileSync(verdictPath, JSON.stringify(VALID_VERDICT), 'utf8');
    assert.deepEqual(loadRiskVerdict(verdictPath), VALID_VERDICT);
  });
});

/**
 * In-memory provider covering the surfaces runSpecPhase touches: Epic
 * reads, ticket creation, label/body mutation, and structured-comment I/O
 * (epic-plan-state checkpoint + risk-verdict comment).
 */
function buildSpecPhaseProvider() {
  let nextId = 700;
  let commentId = 9000;
  const comments = new Map();
  const epic = {
    id: 7000,
    title: 'Verdict Epic',
    body: 'Epic body.',
    labels: ['type::epic'],
    linkedIssues: { prd: null, techSpec: null, acceptanceSpec: null },
  };
  return {
    epic,
    comments,
    async getEpic() {
      return epic;
    },
    async getTicket(id) {
      return { ...epic, id, assignees: epic.assignees ?? [] };
    },
    async getTickets() {
      return [];
    },
    async createTicket(_epicId, ticketData) {
      const id = nextId++;
      return { id, url: `https://stub/issues/${id}`, ...ticketData };
    },
    async updateTicket(id, mutations) {
      if (id !== epic.id) return;
      if (mutations.body !== undefined) epic.body = mutations.body;
      if (mutations.labels) {
        const existing = new Set(epic.labels ?? []);
        for (const add of mutations.labels.add ?? []) existing.add(add);
        for (const rm of mutations.labels.remove ?? []) existing.delete(rm);
        epic.labels = Array.from(existing);
      }
    },
    async getTicketComments(ticketId) {
      return comments.get(ticketId) ?? [];
    },
    async postComment(ticketId, payload) {
      const list = comments.get(ticketId) ?? [];
      const comment = { id: commentId++, body: payload.body };
      list.push(comment);
      comments.set(ticketId, list);
      return comment;
    },
    async deleteComment(id) {
      for (const [, list] of comments) {
        const idx = list.findIndex((entry) => entry.id === id);
        if (idx !== -1) list.splice(idx, 1);
      }
    },
    primeTicketCache() {},
  };
}

const SPEC_LEASE_CFG = {
  github: { owner: 'o', repo: 'r', operatorHandle: '@ci' },
};

describe('runSpecPhase risk-verdict recording', () => {
  it('records the verdict as a risk-verdict structured comment and in the checkpoint', async () => {
    const provider = buildSpecPhaseProvider();

    const result = await runSpecPhase(
      provider.epic.id,
      provider,
      {
        prdContent: '## Overview\nPRD.',
        techSpecContent: '## Technical Overview\nTS.',
      },
      { baseBranch: 'main', paths: { tempRoot: sandbox } },
      { config: SPEC_LEASE_CFG, riskVerdict: VALID_VERDICT },
    );

    // Derived envelope rides the result.
    assert.equal(result.planningRisk.overallLevel, 'high');
    assert.equal(result.planningRisk.gateDecision, 'review-required');

    // The epic-plan-state checkpoint carries the raw verdict.
    assert.deepEqual(result.checkpoint.riskVerdict, VALID_VERDICT);
    assert.equal(result.checkpoint.planningRisk.overallLevel, 'high');

    // A risk-verdict structured comment exists on the Epic with the
    // verdict + derived envelope embedded as fenced JSON.
    const epicComments = provider.comments.get(provider.epic.id) ?? [];
    const verdictComment = epicComments.find((entry) =>
      entry.body.includes('"kind": "risk-verdict"'),
    );
    assert.ok(verdictComment, 'expected a risk-verdict structured comment');
    assert.match(verdictComment.body, /Planning Risk Verdict/);
    assert.match(verdictComment.body, /critical-workflow/);
    assert.match(verdictComment.body, /High-risk planning-gate change\./);
  });

  it('fails closed when the verdict is missing', async () => {
    const provider = buildSpecPhaseProvider();

    await assert.rejects(
      runSpecPhase(
        provider.epic.id,
        provider,
        {
          prdContent: '## Overview\nPRD.',
          techSpecContent: '## Technical Overview\nTS.',
        },
        { baseBranch: 'main', paths: { tempRoot: sandbox } },
        { config: SPEC_LEASE_CFG },
      ),
      /risk verdict is required/,
    );

    // No mutation happened: the Epic never flipped to review-spec.
    assert.ok(!provider.epic.labels.includes('agent::review-spec'));
  });
});

describe('runSpecPhase rerun demotion guard (Story #4019)', () => {
  it('does not demote a fully-planned agent::ready Epic when the spec is unchanged', async () => {
    const provider = buildSpecPhaseProvider();
    // Fully decomposed + planned: artifacts linked, Epic at agent::ready.
    provider.epic.labels = ['type::epic', 'agent::ready'];
    provider.epic.linkedIssues = {
      prd: 801,
      techSpec: 802,
      acceptanceSpec: null,
    };

    const result = await runSpecPhase(
      provider.epic.id,
      provider,
      {
        prdContent: '## Overview\nPRD.',
        techSpecContent: '## Technical Overview\nTS.',
      },
      { baseBranch: 'main', paths: { tempRoot: sandbox } },
      { config: SPEC_LEASE_CFG, riskVerdict: VALID_VERDICT },
    );

    assert.equal(result.specChanged, false);
    assert.equal(result.labelTransition, 'kept-ready');
    assert.ok(
      provider.epic.labels.includes('agent::ready'),
      'agent::ready must survive a no-op spec rerun',
    );
    assert.ok(
      !provider.epic.labels.includes('agent::review-spec'),
      'no demotion to agent::review-spec when the spec did not change',
    );
  });

  it('still flips to agent::review-spec when the spec actually persists', async () => {
    const provider = buildSpecPhaseProvider();
    provider.epic.labels = ['type::epic', 'agent::ready'];
    // No artifacts yet → planEpic persists → demotion is legitimate.

    const result = await runSpecPhase(
      provider.epic.id,
      provider,
      {
        prdContent: '## Overview\nPRD.',
        techSpecContent: '## Technical Overview\nTS.',
      },
      { baseBranch: 'main', paths: { tempRoot: sandbox } },
      { config: SPEC_LEASE_CFG, riskVerdict: VALID_VERDICT },
    );

    assert.equal(result.specChanged, true);
    assert.equal(result.labelTransition, 'review-spec');
    assert.ok(provider.epic.labels.includes('agent::review-spec'));
    assert.ok(!provider.epic.labels.includes('agent::ready'));
  });
});
