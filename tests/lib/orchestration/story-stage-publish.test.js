// The delivery-stage comment: one per Story, published on stage entry from
// the five delivery entry points, advisory and best effort.

import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { runAcceptanceEvalCli } from '../../../.agents/scripts/acceptance-eval.js';
import { runSingleStoryClose } from '../../../.agents/scripts/lib/orchestration/single-story-close/runner.js';
import { runStoryHandoff } from '../../../.agents/scripts/lib/orchestration/story-handoff.js';
import {
  parseDeliveryStage,
  publishDeliveryStage,
} from '../../../.agents/scripts/lib/orchestration/story-stage-publish.js';
import { structuredCommentMarker } from '../../../.agents/scripts/lib/orchestration/ticketing/reads.js';
import { makeTempDir } from '../../../.agents/scripts/lib/test-temp.js';
import { runConfirmMerge } from '../../../.agents/scripts/single-story-confirm-merge.js';
import { runSingleStoryInit } from '../../../.agents/scripts/single-story-init.js';

const STORY = 6109;
const DELIVERY_STAGE_TYPE = 'delivery-stage';
const NOW = () => new Date('2026-11-18T00:00:00.000Z');

/** An in-memory provider holding one issue's comments. */
function fakeProvider(ticket = {}) {
  const comments = [];
  const writes = [];
  let nextId = 1;
  return {
    comments,
    writes,
    async getTicket() {
      return {
        labels: ['type::story', 'agent::ready'],
        title: 'Story',
        body: '## Goal\nx',
        assignees: ['dsj1984'],
        state: 'open',
        ...ticket,
      };
    },
    async updateTicket() {},
    async getTicketComments() {
      return comments.map((c) => ({ ...c }));
    },
    async postComment(_id, { type, body }) {
      writes.push(type);
      const id = nextId++;
      comments.push({ id, body });
      return { id };
    },
    async deleteComment(id) {
      const at = comments.findIndex((c) => c.id === id);
      if (at >= 0) comments.splice(at, 1);
    },
  };
}

const stageComments = (provider) =>
  provider.comments.filter((c) => parseDeliveryStage(c.body));

const throwingProvider = () => ({
  ...fakeProvider(),
  async getTicketComments() {
    throw new Error('GitHub down');
  },
  async postComment() {
    throw new Error('GitHub down');
  },
});

let tempRoot;
beforeEach(() => {
  tempRoot = makeTempDir('mandrel-stage-publish-');
});
afterEach(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

const configFor = () => ({
  project: { baseBranch: 'main', paths: { tempRoot } },
  github: { owner: 'o', repo: 'r', operatorHandle: '@dsj1984' },
});

describe('publishDeliveryStage', () => {
  it('AC-2: several publishes leave exactly one comment carrying the latest stage', async () => {
    const provider = fakeProvider();
    for (const stage of ['build', 'check', 'handoff', 'close']) {
      await publishDeliveryStage({ provider, storyId: STORY, stage, now: NOW });
    }
    const left = stageComments(provider);
    assert.equal(left.length, 1);
    assert.equal(parseDeliveryStage(left[0].body).stage, 'close');
  });

  it('AC-3: entering the stage the comment already names performs no write', async () => {
    const provider = fakeProvider();
    await publishDeliveryStage({ provider, storyId: STORY, stage: 'check' });
    const second = await publishDeliveryStage({
      provider: fakeProviderSharing(provider),
      storyId: STORY,
      stage: 'check',
    });
    assert.equal(second, 'unchanged');
    assert.deepEqual(provider.writes, [DELIVERY_STAGE_TYPE]);
  });

  it('AC-4: a throwing provider, provider factory or missing provider never throws', async () => {
    const debug = [];
    const log = (m) => debug.push(m);
    for (const provider of [
      throwingProvider(),
      () => {
        throw new Error('no token');
      },
      null,
    ]) {
      const out = await publishDeliveryStage({
        provider,
        storyId: STORY,
        stage: 'build',
        debug: log,
      });
      assert.equal(out, 'skipped');
    }
    assert.equal(debug.length, 2);
  });

  it('AC-6: the published body carries only the documented fields', async () => {
    const provider = fakeProvider();
    await publishDeliveryStage({
      provider,
      storyId: STORY,
      stage: 'merge',
      prNumber: 77,
      now: NOW,
    });
    const body = provider.comments[0].body;
    const json = JSON.parse(/```json\n(.*)\n```/.exec(body)[1]);
    assert.deepEqual(Object.keys(json), [
      'kind',
      'storyId',
      'stage',
      'prNumber',
      'updatedAt',
      'history',
    ]);
    assert.deepEqual(json, {
      kind: 'delivery-stage',
      storyId: STORY,
      stage: 'merge',
      prNumber: 77,
      updatedAt: '2026-11-18T00:00:00.000Z',
      history: [{ stage: 'merge', at: '2026-11-18T00:00:00.000Z' }],
    });
    assert.ok(body.startsWith(structuredCommentMarker(DELIVERY_STAGE_TYPE)));
  });
});

describe('AC-4: stage history', () => {
  const at = (n) => new Date(Date.UTC(2026, 10, 18, 0, n)).toISOString();

  it('appends each new stage and keeps the most recent 10', async () => {
    const provider = fakeProvider();
    const stages = ['build', 'check'];
    for (let n = 0; n < 12; n += 1) {
      await publishDeliveryStage({
        provider,
        storyId: STORY,
        stage: stages[n % 2],
        now: () => new Date(at(n)),
      });
    }
    const [comment] = stageComments(provider);
    const { history } = parseDeliveryStage(comment.body);
    assert.equal(history.length, 10);
    assert.deepEqual(history[0], { stage: 'build', at: at(2) });
    assert.deepEqual(history.at(-1), { stage: 'check', at: at(11) });
    assert.ok(comment.body.split('\n').some((l) => l.includes('"history"')));
  });

  it('parses a record without history and seeds the next publish from it', async () => {
    const legacy = {
      kind: 'delivery-stage',
      storyId: STORY,
      stage: 'build',
      prNumber: null,
      updatedAt: at(0),
    };
    const body = `${structuredCommentMarker(DELIVERY_STAGE_TYPE)}\n\n\`\`\`json\n${JSON.stringify(legacy)}\n\`\`\``;
    assert.deepEqual(parseDeliveryStage(body), { ...legacy, history: [] });
    const provider = fakeProvider();
    provider.comments.push({ id: 99, body });
    await publishDeliveryStage({
      provider,
      storyId: STORY,
      stage: 'check',
      now: () => new Date(at(5)),
    });
    const [comment] = stageComments(provider);
    assert.deepEqual(parseDeliveryStage(comment.body).history, [
      { stage: 'build', at: at(0) },
      { stage: 'check', at: at(5) },
    ]);
  });

  it('drops malformed history entries', () => {
    const record = {
      kind: 'delivery-stage',
      storyId: STORY,
      stage: 'check',
      prNumber: null,
      updatedAt: at(1),
      history: [
        { stage: 'deploy', at: at(0) },
        'x',
        { stage: 'check', at: at(1) },
      ],
    };
    const body = `\`\`\`json\n${JSON.stringify(record)}\n\`\`\``;
    assert.deepEqual(parseDeliveryStage(body).history, [
      { stage: 'check', at: at(1) },
    ]);
  });
});

/** A second provider object over the same comments, so no cache is shared. */
function fakeProviderSharing(provider) {
  return { ...provider };
}

describe('parseDeliveryStage', () => {
  it('AC-5: returns the record from a published body and null for any other comment', async () => {
    const record = {
      storyId: STORY,
      stage: 'handoff',
      prNumber: null,
      updatedAt: '2026-11-18T00:00:00.000Z',
    };
    const provider = fakeProvider();
    await publishDeliveryStage({
      provider,
      storyId: STORY,
      stage: 'handoff',
      now: NOW,
    });
    const { body } = provider.comments[0];
    assert.deepEqual(parseDeliveryStage(body), {
      kind: 'delivery-stage',
      ...record,
      history: [{ stage: 'handoff', at: record.updatedAt }],
    });
    for (const other of [
      null,
      42,
      '',
      'a plain comment',
      '```json\n{"kind":"story-outcome"}\n```',
      '```json\n{"kind":"delivery-stage","storyId":1,"stage":"deploy","prNumber":null,"updatedAt":"x"}\n```',
      '```json\n{"kind":"delivery-stage", broken\n```',
    ]) {
      assert.equal(parseDeliveryStage(other), null);
    }
  });
});

describe('AC-1: each entry point publishes its stage', () => {
  it('init completing publishes build', async () => {
    const provider = fakeProvider();
    await runSingleStoryInit({
      storyId: STORY,
      injectedProvider: provider,
      injectedConfig: configFor(),
      injectedVerifyRemote: () => ({ remoteVerified: true, detail: 'ok' }),
      injectedAcquireLease: async () => ({
        acquired: true,
        owner: 'dsj1984',
        reason: 'unclaimed',
      }),
      injectedMaterialize: async () => {},
      injectedSeedBranch: () => {},
      injectedProvisionWorktree: async () => ({
        workCwd: '/tmp/wt',
        worktreeCreated: true,
        installStatus: { status: 'skipped', reason: 'test' },
      }),
      injectedBuildChecklist: () => ({ checklistPath: null }),
    });
    assert.equal(
      parseDeliveryStage(stageComments(provider)[0].body).stage,
      'build',
    );
  });

  it('the acceptance evaluation starting publishes check', async () => {
    const provider = fakeProvider();
    await runAcceptanceEvalCli(
      ['--story', String(STORY), '--init', '--cwd', '/work'],
      {
        resolveConfigImpl: () => configFor(),
        createProviderFn: () => provider,
        initSkeletonImpl: async () => ({ verdictPath: '/v.json' }),
        logger: { info() {} },
      },
    );
    assert.equal(
      parseDeliveryStage(stageComments(provider)[0].body).stage,
      'check',
    );
  });

  it('handoff starting publishes handoff', async () => {
    const provider = fakeProvider();
    await assert.rejects(
      runStoryHandoff(
        { storyId: STORY, cwd: '/work', config: configFor() },
        {
          createProviderFn: () => provider,
          logDir: tempRoot,
          readPackageScriptsFn: () => {
            throw new Error('stop after entry');
          },
        },
      ),
      /stop after entry/,
    );
    assert.equal(
      parseDeliveryStage(stageComments(provider)[0].body).stage,
      'handoff',
    );
  });

  it('close starting publishes close', async () => {
    const provider = fakeProvider();
    provider.getTicket = async () => {
      throw new Error('stop after entry');
    };
    await assert.rejects(
      runSingleStoryClose({
        storyId: STORY,
        cwd: tempRoot,
        injectedProvider: provider,
        injectedConfig: configFor(),
      }),
      /stop after entry/,
    );
    assert.equal(
      parseDeliveryStage(stageComments(provider)[0].body).stage,
      'close',
    );
  });

  const confirm = (provider) =>
    runConfirmMerge({
      storyId: STORY,
      cwd: tempRoot,
      pr: 77,
      wait: true,
      injectedProvider: provider,
      injectedConfig: configFor(),
      injectedNotify: async () => {},
      runConfirmMergePhaseFn: async () => ({
        confirmed: false,
        terminal: 'pending',
        prProbe: { state: 'OPEN', checksStatus: 'still-running' },
      }),
    });

  it('confirm-merge starting publishes merge with the PR number', async () => {
    const provider = fakeProvider();
    await confirm(provider);
    const record = parseDeliveryStage(stageComments(provider)[0].body);
    assert.equal(record.stage, 'merge');
    assert.equal(record.prNumber, 77);
  });

  it('AC-4: a throwing provider leaves the entry point result unchanged', async () => {
    const strip = (r) =>
      JSON.stringify(r, (k, v) =>
        k === 'elapsedSeconds' || k === 'timestamp' ? 0 : v,
      );
    const good = await confirm(fakeProvider());
    const bad = await confirm(throwingProvider());
    assert.equal(strip(bad), strip(good));

    const init = await runAcceptanceEvalCli(
      ['--story', String(STORY), '--init', '--cwd', '/work'],
      {
        resolveConfigImpl: () => configFor(),
        createProviderFn: () => throwingProvider(),
        initSkeletonImpl: async () => ({ verdictPath: '/v.json' }),
        logger: { info() {} },
      },
    );
    // The coordination inbox read is its own advisory field.
    const { coordination: _coordination, ...summary } = init;
    assert.deepEqual(summary, { verdictPath: '/v.json' });
  });
});
