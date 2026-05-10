/**
 * tests/workflows/epic-plan-ideation.test.js — unit tests for the
 * Phase 0c/0d helpers used by the s-plan-ideation entry of /epic-plan.
 *
 * Covers:
 *  - parseOnePager extracts the five canonical sections + title
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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE_PATH = path.resolve(
  __dirname,
  '../../.agents/templates/epic-from-idea.md',
);

const SAMPLE_ONE_PAGER = `# Webhook Idempotency Layer

## Problem Statement

Duplicate webhook deliveries cause double-charged invoices.

## Recommended Direction

Introduce a fingerprint-keyed dedup store with 24h TTL. The store sits
in front of the webhook handler and short-circuits replays.

## Key Assumptions to Validate

- [ ] Replays arrive within 24h
- [ ] Fingerprint hash is stable across providers

## MVP Scope

In: Stripe + GitHub webhooks. Out: per-tenant TTL tuning.

## Not Doing (and Why)

- Cross-region replication — single-region MVP is enough.
`;

describe('parseOnePager', () => {
  it('extracts title and all five canonical sections', () => {
    const out = parseOnePager(SAMPLE_ONE_PAGER);
    assert.equal(out.title, 'Webhook Idempotency Layer');
    assert.match(out.problem, /Duplicate webhook deliveries/);
    assert.match(out.direction, /fingerprint-keyed dedup store/);
    assert.match(out.assumptions, /Replays arrive within 24h/);
    assert.match(out.mvpScope, /Stripe \+ GitHub webhooks/);
    assert.match(out.notDoing, /Cross-region replication/);
  });

  it('returns Untitled Epic when no h1 is present', () => {
    const out = parseOnePager(
      '## Problem Statement\nthing\n## Recommended Direction\nway',
    );
    assert.equal(out.title, 'Untitled Epic');
    assert.match(out.problem, /thing/);
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
      onePager: SAMPLE_ONE_PAGER,
      template,
    });
    assert.equal(title, 'Webhook Idempotency Layer');
    assert.match(body, /^# Webhook Idempotency Layer/m);
    assert.match(body, /## Problem\n\nDuplicate webhook/);
    assert.match(body, /## Direction\n\nIntroduce a fingerprint-keyed/);
    assert.match(body, /## Assumptions\n\n- \[ \] Replays/);
    assert.match(body, /## MVP Scope\n\nIn: Stripe/);
    assert.match(body, /## Not Doing\n\n- Cross-region/);
    // No leftover {{ tokens
    assert.ok(!body.includes('{{'));
  });

  it('flags missing sections instead of leaving raw tokens', () => {
    const template = fs.readFileSync(TEMPLATE_PATH, 'utf8');
    const minimal =
      '# Tiny Epic\n\n## Problem Statement\n\nOnly a problem here.\n';
    const { body } = renderEpicBody({ onePager: minimal, template });
    assert.match(body, /## Direction\n\n_\(not specified\)_/);
    assert.match(body, /## MVP Scope\n\n_\(not specified\)_/);
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
      onePager: SAMPLE_ONE_PAGER,
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
    assert.match(captured.body, /## Problem\n\nDuplicate webhook/);

    // Returned envelope
    assert.equal(out.id, 4242);
    assert.equal(out.url, 'https://github.com/acme/core/issues/4242');
    assert.deepEqual(out.labels, ['type::epic']);
    assert.equal(out.payload, captured);
  });

  it('rejects when createIssue is not a function', async () => {
    const template = fs.readFileSync(TEMPLATE_PATH, 'utf8');
    await assert.rejects(
      () =>
        openEpicFromOnePager({
          onePager: SAMPLE_ONE_PAGER,
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
          onePager: SAMPLE_ONE_PAGER,
          template,
          createIssue: async () => ({ url: 'no-id' }),
        }),
      /createIssue must return/,
    );
  });
});
