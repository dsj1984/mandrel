/**
 * tests/workflows/epic-plan-ideation.test.js — unit tests for the
 * Phase 0c/0d helpers used by the s-plan-ideation entry of /epic-plan.
 *
 * Covers:
 *  - parseOnePager extracts the five canonical sections + title from
 *    both the new canonical heading shape and the legacy ideation shape
 *  - renderEpicBody substitutes template tokens and flags missing
 *    sections
 *  - openEpicFromOnePager calls the injected createIssue port with the
 *    correct payload, including the `type::epic` label and *no*
 *    state::* label
 *  - openEpicFromOnePager validates createIssue's return shape
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  openEpicFromOnePager,
  parseOnePager,
  renderEpicBody,
} from '../../.agents/scripts/lib/epic-plan-ideation.js';
import { createGh } from '../../.agents/scripts/lib/gh-exec.js';
import { TicketGateway } from '../../.agents/scripts/providers/github/tickets.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE_PATH = path.resolve(
  __dirname,
  '../../.agents/templates/epic-from-idea.md',
);

const CANONICAL_ONE_PAGER = `# Webhook Idempotency Layer

## Context

Duplicate webhook deliveries cause double-charged invoices. We bet
that replays arrive within 24h.

## Goal

Introduce a fingerprint-keyed dedup store with 24h TTL. The store sits
in front of the webhook handler and short-circuits replays.

## Non-Goals

- Cross-region replication — single-region MVP is enough.

## Scope

In: Stripe + GitHub webhooks. Out: per-tenant TTL tuning.

## Acceptance Criteria

- [ ] Duplicate Stripe webhook within 24h does not produce a second invoice.
- [ ] Latency overhead on the happy path stays under 5ms p95.
`;

const LEGACY_ONE_PAGER = `# Webhook Idempotency Layer

## Problem Statement

Duplicate webhook deliveries cause double-charged invoices.

## Recommended Direction

Introduce a fingerprint-keyed dedup store with 24h TTL. The store sits
in front of the webhook handler and short-circuits replays.

## MVP Scope

In: Stripe + GitHub webhooks. Out: per-tenant TTL tuning.

## Not Doing (and Why)

- Cross-region replication — single-region MVP is enough.

## Acceptance Criteria

- [ ] Duplicate Stripe webhook within 24h does not produce a second invoice.
`;

describe('parseOnePager', () => {
  it('extracts title and all five canonical sections from the canonical shape', () => {
    const out = parseOnePager(CANONICAL_ONE_PAGER);
    assert.equal(out.title, 'Webhook Idempotency Layer');
    assert.match(out.context, /Duplicate webhook deliveries/);
    assert.match(out.goal, /fingerprint-keyed dedup store/);
    assert.match(out.nonGoals, /Cross-region replication/);
    assert.match(out.scope, /Stripe \+ GitHub webhooks/);
    assert.match(out.acceptanceCriteria, /Duplicate Stripe webhook/);
  });

  it('parses the legacy ideation-shape one-pager (Problem / Direction / MVP Scope / Not Doing)', () => {
    const out = parseOnePager(LEGACY_ONE_PAGER);
    assert.equal(out.title, 'Webhook Idempotency Layer');
    assert.match(out.context, /Duplicate webhook deliveries/);
    assert.match(out.goal, /fingerprint-keyed dedup store/);
    assert.match(out.nonGoals, /Cross-region replication/);
    assert.match(out.scope, /Stripe \+ GitHub webhooks/);
    assert.match(out.acceptanceCriteria, /Duplicate Stripe webhook/);
  });

  it('returns Untitled Epic when no h1 is present', () => {
    const out = parseOnePager('## Context\nthing\n## Goal\nway');
    assert.equal(out.title, 'Untitled Epic');
    assert.match(out.context, /thing/);
  });

  it('rejects empty input', () => {
    assert.throws(() => parseOnePager(''), /non-empty string/);
    assert.throws(() => parseOnePager(null), /non-empty string/);
  });
});

describe('renderEpicBody', () => {
  it('substitutes all five section tokens against the canonical template', () => {
    const template = fs.readFileSync(TEMPLATE_PATH, 'utf8');
    const { title, body } = renderEpicBody({
      onePager: CANONICAL_ONE_PAGER,
      template,
    });
    assert.equal(title, 'Webhook Idempotency Layer');
    assert.match(body, /^# Webhook Idempotency Layer/m);
    assert.match(body, /## Context\n\nDuplicate webhook/);
    assert.match(body, /## Goal\n\nIntroduce a fingerprint-keyed/);
    assert.match(body, /## Non-Goals\n\n- Cross-region/);
    assert.match(body, /## Scope\n\nIn: Stripe/);
    assert.match(body, /## Acceptance Criteria\n\n- \[ \] Duplicate Stripe/);
    // No leftover {{ tokens
    assert.ok(!body.includes('{{'));
  });

  it('flags missing sections instead of leaving raw tokens', () => {
    const template = fs.readFileSync(TEMPLATE_PATH, 'utf8');
    const minimal = '# Tiny Epic\n\n## Context\n\nOnly a context here.\n';
    const { body } = renderEpicBody({ onePager: minimal, template });
    assert.match(body, /## Goal\n\n_\(not specified\)_/);
    assert.match(body, /## Scope\n\n_\(not specified\)_/);
    assert.match(body, /## Acceptance Criteria\n\n_\(not specified\)_/);
    assert.ok(!body.includes('{{'));
  });
});

describe('openEpicFromOnePager', () => {
  it('calls createIssue with type::epic and no state::* label', async () => {
    const template = fs.readFileSync(TEMPLATE_PATH, 'utf8');
    let captured = null;
    const createIssue = async (payload) => {
      captured = payload;
      return { id: 4242, url: 'https://github.com/acme/core/issues/4242' };
    };

    const out = await openEpicFromOnePager({
      onePager: CANONICAL_ONE_PAGER,
      template,
      createIssue,
    });

    // Captured payload assertions
    assert.ok(captured, 'createIssue was not called');
    assert.equal(captured.title, 'Webhook Idempotency Layer');
    assert.deepEqual(captured.labels, ['type::epic']);
    for (const lbl of captured.labels) {
      assert.ok(
        !lbl.startsWith('state::'),
        `state::* label leaked into payload: ${lbl}`,
      );
    }
    assert.match(captured.body, /## Context\n\nDuplicate webhook/);

    // Returned envelope
    assert.equal(out.id, 4242);
    assert.equal(out.url, 'https://github.com/acme/core/issues/4242');
    assert.deepEqual(out.labels, ['type::epic']);
    assert.equal(out.payload, captured);
  });

  it('surfaces nodeId from the createIssue port, defaulting to null when absent (Story #3822)', async () => {
    const template = fs.readFileSync(TEMPLATE_PATH, 'utf8');
    const withNode = await openEpicFromOnePager({
      onePager: CANONICAL_ONE_PAGER,
      template,
      createIssue: async () => ({ id: 1, nodeId: 'node_1' }),
    });
    assert.equal(withNode.nodeId, 'node_1');

    const withoutNode = await openEpicFromOnePager({
      onePager: CANONICAL_ONE_PAGER,
      template,
      createIssue: async () => ({ id: 2 }),
    });
    assert.equal(withoutNode.nodeId, null);
  });

  it('rejects when createIssue is not a function', async () => {
    const template = fs.readFileSync(TEMPLATE_PATH, 'utf8');
    await assert.rejects(
      () =>
        openEpicFromOnePager({
          onePager: CANONICAL_ONE_PAGER,
          template,
          createIssue: 'not-a-fn',
        }),
      /createIssue must be a function/,
    );
  });

  it('rejects when createIssue returns an invalid envelope', async () => {
    const template = fs.readFileSync(TEMPLATE_PATH, 'utf8');
    await assert.rejects(
      () =>
        openEpicFromOnePager({
          onePager: CANONICAL_ONE_PAGER,
          template,
          createIssue: async () => ({ url: 'no-id' }),
        }),
      /createIssue must return/,
    );
  });
});

/**
 * Story #3822 — Epic-open path board membership regression.
 *
 * Drives `openEpicFromOnePager` through a createIssue port backed by the
 * real `TicketGateway.createIssue` (fake gh facade, recording hooks) —
 * the production wiring the `/epic-plan` Phase 4 workflow prescribes —
 * and proves the board-add helper fires with the new issue's `node_id`
 * when a project number is configured, and skips cleanly when it is not.
 */
describe('openEpicFromOnePager — Projects V2 board membership (Story #3822)', () => {
  function makeGateway({ projectNumber }) {
    const projectCalls = [];
    const exec = async ({ args, input }) => {
      const method = args[2] ?? 'GET';
      if (method === 'POST') {
        const posted = JSON.parse(input);
        return {
          stdout: JSON.stringify({
            number: 5151,
            id: 51510,
            node_id: 'node_5151',
            html_url: 'https://example/5151',
            title: posted.title,
          }),
          stderr: '',
          code: 0,
        };
      }
      return { stdout: '{}', stderr: '', code: 0 };
    };
    const gateway = new TicketGateway({
      gh: createGh(exec),
      owner: 'o',
      repo: 'r',
      hooks: {
        addItemToProject: async (nodeId) => {
          projectCalls.push(nodeId);
        },
        getProjectNumber: () => projectNumber,
      },
    });
    return { gateway, projectCalls };
  }

  it('adds the new Epic to the board with its node_id when a project number is set', async () => {
    const template = fs.readFileSync(TEMPLATE_PATH, 'utf8');
    const { gateway, projectCalls } = makeGateway({ projectNumber: 1 });

    const out = await openEpicFromOnePager({
      onePager: CANONICAL_ONE_PAGER,
      template,
      createIssue: (payload) => gateway.createIssue(payload),
    });

    assert.equal(out.id, 5151);
    assert.equal(out.nodeId, 'node_5151');
    assert.deepEqual(projectCalls, ['node_5151']);
  });

  it('skips the board add cleanly when no project number is configured', async () => {
    const template = fs.readFileSync(TEMPLATE_PATH, 'utf8');
    const { gateway, projectCalls } = makeGateway({ projectNumber: null });

    const out = await openEpicFromOnePager({
      onePager: CANONICAL_ONE_PAGER,
      template,
      createIssue: (payload) => gateway.createIssue(payload),
    });

    assert.equal(out.id, 5151);
    assert.equal(out.nodeId, 'node_5151');
    assert.deepEqual(projectCalls, []);
  });
});
