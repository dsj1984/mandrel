/**
 * Unit tests for `ultrareview.js` — Story #2871.
 *
 * Verifies the manual-prompt provider contract:
 *   - `renderPrompt()` returns `{ message }` with the canonical
 *     suggestion text rendered against the live scope/baseRef/headRef.
 *   - The adapter NEVER throws under any host (manual-prompt
 *     providers MUST be host-agnostic by AC-5).
 *   - The exported template is a stable string so doc tooling can
 *     lift it without spawning a fake review.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildUltrareviewMessage,
  createUltrareviewProvider,
  createUltrareviewProviderForRegistry,
  ULTRAREVIEW_PROMPT_TEMPLATE,
} from '../../../../.agents/scripts/lib/orchestration/review-providers/ultrareview.js';

test('ULTRAREVIEW_PROMPT_TEMPLATE: contains the placeholder tokens', () => {
  assert.match(ULTRAREVIEW_PROMPT_TEMPLATE, /{scopeLabel}/);
  assert.match(ULTRAREVIEW_PROMPT_TEMPLATE, /{baseRef}/);
  assert.match(ULTRAREVIEW_PROMPT_TEMPLATE, /{headRef}/);
  assert.match(ULTRAREVIEW_PROMPT_TEMPLATE, /ultrareview/);
});

test('buildUltrareviewMessage: substitutes Epic scope and refs', () => {
  const msg = buildUltrareviewMessage({
    scope: 'epic',
    ticketId: 42,
    baseRef: 'main',
    headRef: 'epic/42',
  });
  assert.match(msg, /Epic/);
  assert.match(msg, /`main`/);
  assert.match(msg, /`epic\/42`/);
  assert.doesNotMatch(msg, /{scopeLabel}/);
});

test('buildUltrareviewMessage: substitutes Story scope', () => {
  const msg = buildUltrareviewMessage({
    scope: 'story',
    ticketId: 7,
    baseRef: 'epic/2',
    headRef: 'story-7',
  });
  assert.match(msg, /Story/);
  assert.match(msg, /`epic\/2`/);
  assert.match(msg, /`story-7`/);
});

test('buildUltrareviewMessage: degrades to "?" placeholders on bad input', () => {
  const msg = buildUltrareviewMessage(undefined);
  assert.match(msg, /Story/); // default when scope unknown
  assert.match(msg, /`\?`/);
});

test('createUltrareviewProvider: renderPrompt resolves with a non-empty message', async () => {
  const provider = createUltrareviewProvider();
  const result = await provider.renderPrompt({
    scope: 'epic',
    ticketId: 42,
    baseRef: 'main',
    headRef: 'epic/42',
  });
  assert.equal(typeof result.message, 'string');
  assert.ok(result.message.length > 0);
});

test('createUltrareviewProvider: NEVER throws on bad input (host-agnostic contract)', async () => {
  const provider = createUltrareviewProvider();
  await assert.doesNotReject(() => provider.renderPrompt(null));
  await assert.doesNotReject(() => provider.renderPrompt({}));
  await assert.doesNotReject(() => provider.renderPrompt({ scope: 'epic' }));
});

test('createUltrareviewProvider: forwards an info log when provided', async () => {
  const calls = [];
  const provider = createUltrareviewProvider({
    logger: { info: (m) => calls.push(m) },
  });
  await provider.renderPrompt({
    scope: 'epic',
    ticketId: 1,
    baseRef: 'a',
    headRef: 'b',
  });
  assert.ok(calls.length > 0);
  assert.match(calls[0], /ultrareview/i);
});

test('createUltrareviewProviderForRegistry: zero-arg factory entry point', () => {
  const provider = createUltrareviewProviderForRegistry();
  assert.equal(typeof provider.renderPrompt, 'function');
});
