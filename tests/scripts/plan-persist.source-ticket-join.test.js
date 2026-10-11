/**
 * The plan-persist.js CLI join: parsed flags → envelope discovery →
 * `runPlanPersist` opts (Story #4554).
 *
 * The unit tests around `resolveSourceTicketIds` prove the resolver; these
 * prove the CLI actually *wires it up*. Without this, a regression in
 * `buildPersistOptions` would silently un-wire `/mandrel-plan --tickets` superseding
 * while every resolver test stayed green.
 */

import assert from 'node:assert/strict';
import { rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { PLAN_CONTEXT_FILENAME } from '../../.agents/scripts/lib/orchestration/plan-persist/plan-context-source.js';
import { makeTempDir } from '../../.agents/scripts/lib/test-temp.js';
import {
  assertEpicFlagsExclusive,
  buildPersistOptions,
  resolveEpicAdoptionId,
  resolveEpicRequest,
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
    ...overrides,
  };
}

async function planDirWithEnvelope(envelope = TICKETS_ENVELOPE) {
  const dir = await makeTempDir('persist-join-');
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

  // Story #5604 — a one-for-one plan rewrites its source unless opted out.
  it('defaults to rewriting the source and lets --no-rewrite-source opt out', () => {
    const paths = resolveInputPaths(values());
    assert.equal(
      buildPersistOptions(values(), paths, TICKETS_ENVELOPE).rewriteSource,
      true,
    );
    assert.equal(
      buildPersistOptions(
        values({ 'rewrite-source': true, 'no-rewrite-source': true }),
        paths,
        TICKETS_ENVELOPE,
      ).rewriteSource,
      false,
    );
  });
});

/**
 * Story #5139 — the container-Epic flags reach `runPlanPersist` as one
 * `epic` opt, and a half-specified request is a loud usage error rather than
 * a silent no-Epic run. The silent form is the dangerous one: the operator
 * asked for a container and would never learn they did not get one.
 */
describe('buildPersistOptions — the container-Epic request', () => {
  it('is null when neither flag is given', () => {
    const opts = buildPersistOptions(values(), { planDir: null }, null);
    assert.equal(opts.epic, null);
  });

  it('carries both halves through when the pair is given', () => {
    const opts = buildPersistOptions(
      values({ 'epic-title': ' Auth work ', 'epic-goal': ' Group it. ' }),
      { planDir: null },
      null,
    );
    assert.deepEqual(opts.epic, { title: 'Auth work', goal: 'Group it.' });
  });

  it('throws on a title with no goal', () => {
    assert.throws(
      () =>
        buildPersistOptions(
          values({ 'epic-title': 'Auth work' }),
          { planDir: null },
          null,
        ),
      /must be supplied together/,
    );
  });

  it('throws on a goal with no title', () => {
    assert.throws(
      () =>
        buildPersistOptions(
          values({ 'epic-goal': 'Group it.' }),
          { planDir: null },
          null,
        ),
      /must be supplied together/,
    );
  });

  it('treats whitespace-only flags as absent, not as a half request', () => {
    const opts = buildPersistOptions(
      values({ 'epic-title': '   ', 'epic-goal': '  ' }),
      { planDir: null },
      null,
    );
    assert.equal(opts.epic, null);
  });
});

describe('the Epic flag surface (Story #5155)', () => {
  it('refuses --epic together with either creation flag', () => {
    for (const extra of [{ 'epic-title': 'T' }, { 'epic-goal': 'G' }]) {
      assert.throws(
        () => assertEpicFlagsExclusive({ epic: '90', ...extra }),
        /mutually exclusive/,
      );
    }
  });

  it('allows either form on its own, and neither', () => {
    assert.doesNotThrow(() => assertEpicFlagsExclusive({ epic: '90' }));
    assert.doesNotThrow(() =>
      assertEpicFlagsExclusive({ 'epic-title': 'T', 'epic-goal': 'G' }),
    );
    assert.doesNotThrow(() => assertEpicFlagsExclusive({}));
  });

  it('parses --epic, tolerating a leading #', () => {
    assert.equal(resolveEpicAdoptionId({ epic: '90' }), 90);
    assert.equal(resolveEpicAdoptionId({ epic: '#90' }), 90);
    assert.equal(resolveEpicAdoptionId({ epic: '  90  ' }), 90);
    assert.equal(resolveEpicAdoptionId({}), null);
    assert.equal(resolveEpicAdoptionId({ epic: '' }), null);
  });

  it('rejects a non-numeric or non-positive --epic before any I/O', () => {
    for (const bad of ['abc', '0', '-3']) {
      assert.throws(
        () => resolveEpicAdoptionId({ epic: bad }),
        /positive issue id/,
      );
    }
  });

  it('still requires --epic-title and --epic-goal together', () => {
    assert.equal(resolveEpicRequest({}), null);
    assert.deepEqual(
      resolveEpicRequest({ 'epic-title': 'T', 'epic-goal': 'G' }),
      { title: 'T', goal: 'G' },
    );
    assert.throws(
      () => resolveEpicRequest({ 'epic-title': 'T' }),
      /must be supplied together/,
    );
  });

  it('wires both Epic paths into the persist opts', () => {
    const adopt = buildPersistOptions(
      { epic: '90' },
      resolveInputPaths({ stories: 's.json' }),
      null,
    );
    assert.equal(adopt.adoptEpicId, 90);
    assert.equal(adopt.epic, null);

    const create = buildPersistOptions(
      { 'epic-title': 'T', 'epic-goal': 'G' },
      resolveInputPaths({ stories: 's.json' }),
      null,
    );
    assert.equal(create.adoptEpicId, null);
    assert.deepEqual(create.epic, { title: 'T', goal: 'G' });
  });
});
