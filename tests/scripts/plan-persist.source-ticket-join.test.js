/**
 * The plan-persist.js CLI join: parsed flags → envelope discovery →
 * `runPlanPersist` opts (Story #4554).
 *
 * The unit tests around `resolveSourceTicketIds` prove the resolver; these
 * prove the CLI actually *wires it up*. Without this, a regression in
 * `buildPersistOptions` would silently un-wire `/plan --tickets` superseding
 * while every resolver test stayed green.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { PLAN_CONTEXT_FILENAME } from '../../.agents/scripts/lib/orchestration/plan-persist/plan-context-source.js';
import {
  buildPersistOptions,
  resolveInputPaths,
} from '../../.agents/scripts/plan-persist.js';

const TICKETS_ENVELOPE = {
  mode: 'tickets',
  sourceTickets: [{ id: 4525, title: 'Old idea', body: '' }],
};

/** The minimum `parseArgs` values plan-persist needs to resolve paths. */
function values(overrides = {}) {
  return {
    stories: 'temp/stories.json',
    'risk-verdict': 'temp/risk-verdict.json',
    ...overrides,
  };
}

async function planDirWithEnvelope(envelope = TICKETS_ENVELOPE) {
  const dir = await mkdtemp(path.join(tmpdir(), 'persist-join-'));
  await writeFile(
    path.join(dir, PLAN_CONTEXT_FILENAME),
    JSON.stringify(envelope),
    'utf8',
  );
  return dir;
}

describe('plan-persist CLI join — source ticket ids (Story #4554)', () => {
  it('resolves the envelope path from --plan-dir by convention', () => {
    const paths = resolveInputPaths(values({ 'plan-dir': 'temp/plan-x' }));
    assert.equal(
      paths.planContextPath.path,
      path.join(path.resolve('temp/plan-x'), PLAN_CONTEXT_FILENAME),
    );
    assert.equal(paths.planContextPath.explicit, false);
  });

  it('resolves nothing to read when neither --plan-dir nor --plan-context is given', () => {
    assert.equal(resolveInputPaths(values()).planContextPath, null);
  });

  // The end-to-end join: --plan-dir only, no --source-tickets anywhere.
  it('threads envelope-derived ids into the persist opts with no --source-tickets flag', async () => {
    const dir = await planDirWithEnvelope();
    const paths = resolveInputPaths(values({ 'plan-dir': dir }));
    const opts = buildPersistOptions(values({ 'plan-dir': dir }), paths, {
      ...TICKETS_ENVELOPE,
    });

    assert.deepEqual(opts.sourceTicketIds, [4525]);
    assert.equal(opts.sourceTicketOrigin, 'envelope');
    assert.equal(opts.closeSuperseded, true);
    await rm(dir, { recursive: true, force: true });
  });

  it('lets --source-tickets override the envelope through the join', () => {
    const opts = buildPersistOptions(
      values({ 'source-tickets': '4999' }),
      resolveInputPaths(values()),
      TICKETS_ENVELOPE,
    );
    assert.deepEqual(opts.sourceTicketIds, [4999]);
    assert.equal(opts.sourceTicketOrigin, 'flag');
  });

  it('reports origin "none" with no envelope and no flag', () => {
    const opts = buildPersistOptions(
      values(),
      resolveInputPaths(values()),
      null,
    );
    assert.deepEqual(opts.sourceTicketIds, []);
    assert.equal(opts.sourceTicketOrigin, 'none');
  });

  it('keeps --no-close-superseded winning over the derived ids', () => {
    const opts = buildPersistOptions(
      values({ 'no-close-superseded': true }),
      resolveInputPaths(values()),
      TICKETS_ENVELOPE,
    );
    // Ids still resolve — the flag disables the close phase, not the partition.
    assert.deepEqual(opts.sourceTicketIds, [4525]);
    assert.equal(opts.closeSuperseded, false);
  });
});
