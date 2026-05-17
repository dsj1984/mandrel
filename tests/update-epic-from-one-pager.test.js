/**
 * tests/update-epic-from-one-pager.test.js — unit tests for the
 * `updateEpicFromOnePager` helper used by the Phase 6 Epic Clarity Gate.
 *
 * Covers:
 *  - Identical body → no editIssue call (`changed: false`).
 *  - Different body → editIssue called once with `{ epicId, body }`.
 *  - Missing editIssue → throws synchronously.
 *  - Render uses the same template as `openEpicFromOnePager`.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  openEpicFromOnePager,
  renderEpicBody,
  updateEpicFromOnePager,
} from '../.agents/scripts/lib/epic-plan-ideation.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE_PATH = path.resolve(
  __dirname,
  '../.agents/templates/epic-from-idea.md',
);

const ONE_PAGER = `# Refined Idea

## Problem Statement

Customers cannot search past invoices.

## Recommended Direction

Add a full-text invoice search endpoint backed by Postgres GIN.

## Key Assumptions to Validate

- Search latency stays under 500ms on representative tenant data.

## MVP Scope

In: invoices owned by the requesting tenant. Out: cross-tenant search.

## Not Doing (and Why)

- Full-text on attachments — out of MVP.
`;

describe('updateEpicFromOnePager', () => {
  it('throws synchronously when editIssue is not a function', async () => {
    await assert.rejects(
      () =>
        updateEpicFromOnePager({
          epicId: 42,
          onePager: ONE_PAGER,
          template: fs.readFileSync(TEMPLATE_PATH, 'utf8'),
          editIssue: null,
        }),
      /editIssue must be a function/,
    );
  });

  it('throws when epicId is not a positive integer', async () => {
    await assert.rejects(
      () =>
        updateEpicFromOnePager({
          epicId: 0,
          onePager: ONE_PAGER,
          template: fs.readFileSync(TEMPLATE_PATH, 'utf8'),
          editIssue: async () => {},
        }),
      /positive integer/,
    );
    await assert.rejects(
      () =>
        updateEpicFromOnePager({
          epicId: -5,
          onePager: ONE_PAGER,
          template: fs.readFileSync(TEMPLATE_PATH, 'utf8'),
          editIssue: async () => {},
        }),
      /positive integer/,
    );
  });

  it('calls editIssue once with { epicId, body } when bodies differ', async () => {
    const calls = [];
    const editIssue = async (payload) => {
      calls.push(payload);
    };
    const template = fs.readFileSync(TEMPLATE_PATH, 'utf8');

    const result = await updateEpicFromOnePager({
      epicId: 42,
      onePager: ONE_PAGER,
      template,
      editIssue,
      currentBody: 'stale body content',
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].epicId, 42);
    assert.ok(calls[0].body.startsWith('# Refined Idea'));
    assert.equal(result.changed, true);
    assert.equal(result.epicId, 42);
    assert.equal(result.title, 'Refined Idea');
    assert.equal(result.body, calls[0].body);
    assert.deepEqual(result.payload, calls[0]);
  });

  it('returns changed=false and skips editIssue when current body matches', async () => {
    const template = fs.readFileSync(TEMPLATE_PATH, 'utf8');
    const { body: renderedBody } = renderEpicBody({
      onePager: ONE_PAGER,
      template,
    });

    let callCount = 0;
    const editIssue = async () => {
      callCount += 1;
    };

    const result = await updateEpicFromOnePager({
      epicId: 99,
      onePager: ONE_PAGER,
      template,
      editIssue,
      currentBody: renderedBody,
    });

    assert.equal(callCount, 0);
    assert.equal(result.changed, false);
    assert.equal(result.body, renderedBody);
  });

  it('renders the same template body as openEpicFromOnePager', async () => {
    const template = fs.readFileSync(TEMPLATE_PATH, 'utf8');

    let opened;
    await openEpicFromOnePager({
      onePager: ONE_PAGER,
      template,
      createIssue: async (payload) => {
        opened = payload;
        return { id: 1, url: 'https://example/1' };
      },
    });

    let updated;
    await updateEpicFromOnePager({
      epicId: 1,
      onePager: ONE_PAGER,
      template,
      editIssue: async (payload) => {
        updated = payload;
      },
    });

    assert.equal(updated.body, opened.body);
  });
});
