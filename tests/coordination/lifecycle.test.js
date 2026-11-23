import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { COORDINATION_DISABLED_ENV } from '../../.agents/scripts/lib/config/github.js';
import { publishEvent } from '../../.agents/scripts/lib/coordination/channel.js';
import {
  decodeEventComment,
  isEventComment,
} from '../../.agents/scripts/lib/coordination/event.js';
import {
  publishLanded,
  publishPlanChanges,
  surfaceInbox,
} from '../../.agents/scripts/lib/coordination/lifecycle.js';
import { runSingleStoryInit } from '../../.agents/scripts/single-story-init.js';
import {
  fakeGit,
  makeChannelConfig,
  makeChannelProvider,
  storyBody,
} from '../helpers/coordination-channel.js';

const T0 = Date.parse('2026-11-20T12:00:00Z');
const GITHUB = { owner: 'octo', repo: 'demo' };

const STORIES = {
  7: {
    title: 'Seven',
    labels: ['type::story', 'agent::ready'],
    body: storyBody({ paths: ['lib/a.js'] }),
  },
  8: { body: storyBody({ paths: ['lib/b.js'] }) },
};

/**
 * One channel world: a provider, a config with its own temp root, a clock the
 * test moves, the lines a surface printed, and the overrides a surface takes.
 */
function world({ tickets = STORIES } = {}) {
  const clock = { now: new Date(T0) };
  const provider = makeChannelProvider({
    tickets,
    clock: () => clock.now.toISOString(),
  });
  const config = makeChannelConfig();
  const lines = [];
  const now = () => clock.now;
  const overrides = {
    env: {},
    now,
    git: fakeGit(),
    write: (block) => lines.push(block),
  };
  return {
    clock,
    provider,
    config,
    lines,
    overrides,
    /** Everything `surfaceInbox` needs to read Story 7's inbox. */
    reader: { storyId: 7, config, provider, ...overrides },
    publish: (input) => publishEvent(input, { config, provider, env: {}, now }),
    advance(seconds) {
      clock.now = new Date(clock.now.getTime() + seconds * 1000);
    },
  };
}

/** The decoded coordination events posted on the provider, oldest first. */
const eventsOn = (provider) =>
  provider.comments
    .filter((comment) => isEventComment(comment.body))
    .map((comment) => decodeEventComment(comment, GITHUB));

const landedOnA = (summary = 'Sibling landed') => ({
  kind: 'landed',
  summary,
  paths: ['lib/a.js'],
  storyId: 8,
});

const summaries = (coordination) => coordination.events.map((e) => e.summary);

describe('surfaceInbox', () => {
  it('prints the rendered block and lists the pertinent events', async () => {
    const w = world();
    await w.publish(landedOnA());
    const coordination = await surfaceInbox(w.reader);
    assert.deepEqual(summaries(coordination), ['Sibling landed']);
    assert.deepEqual(Object.keys(coordination), ['events']);
    assert.equal(w.lines.length, 1);
    assert.match(w.lines[0], /^\[Coordination\] 1 pertinent event\(s\)/);
    assert.match(w.lines[0], /landed \(conflict\) by @alice on #8/);
  });

  it('prints to stderr when the surface names no writer', async (t) => {
    const w = world();
    await w.publish(landedOnA());
    const written = [];
    t.mock.method(process.stderr, 'write', (chunk) => written.push(chunk));
    const { write: _write, ...reader } = w.reader;
    await surfaceInbox(reader);
    t.mock.restoreAll();
    assert.equal(written.length, 1);
    assert.match(written[0], /^\[Coordination\] 1 pertinent event\(s\).*\n$/s);
  });

  it('a default read returns each event once and prints nothing when none is new', async () => {
    const w = world();
    await w.publish(landedOnA());
    await surfaceInbox(w.reader);
    const again = await surfaceInbox(w.reader);
    assert.deepEqual(again, { events: [] });
    assert.equal(w.lines.length, 1);
  });

  it('says nothing about an event that is not pertinent', async () => {
    const w = world();
    await w.publish({ ...landedOnA(), paths: ['lib/elsewhere.js'] });
    assert.deepEqual(await surfaceInbox(w.reader), { events: [] });
    assert.deepEqual(w.lines, []);
  });

  it('since-start re-lists what an earlier read returned and leaves the cursor alone', async () => {
    const w = world();
    await w.publish(landedOnA('first'));
    await surfaceInbox(w.reader);
    w.advance(10);
    await w.publish(landedOnA('second'));
    const all = await surfaceInbox({ ...w.reader, mode: 'since-start' });
    assert.deepEqual(summaries(all), ['first', 'second']);
    assert.match(w.lines.at(-1), /2 pertinent event\(s\)/);
    const unseen = await surfaceInbox(w.reader);
    assert.deepEqual(summaries(unseen), ['second']);
  });

  it('throttle skips a read inside 120 seconds, then returns only the unseen events', async () => {
    const w = world();
    const throttled = { ...w.reader, mode: 'throttle' };
    await w.publish(landedOnA('first'));
    assert.deepEqual(summaries(await surfaceInbox(throttled)), ['first']);
    w.advance(30);
    await w.publish(landedOnA('second'));
    assert.deepEqual(await surfaceInbox(throttled), {
      events: [],
      skipped: 'throttled',
    });
    assert.equal(w.lines.length, 1);
    w.advance(121);
    assert.deepEqual(summaries(await surfaceInbox(throttled)), ['second']);
    assert.doesNotMatch(w.lines.at(-1), /first/);
  });

  it('a disabled channel makes no provider call and prints nothing', async () => {
    for (const disabled of [
      { env: { [COORDINATION_DISABLED_ENV]: '1' } },
      { config: makeChannelConfig({ coordination: { enabled: false } }) },
    ]) {
      const w = world();
      await w.publish(landedOnA());
      w.provider.calls.length = 0;
      const coordination = await surfaceInbox({ ...w.reader, ...disabled });
      assert.deepEqual(coordination, { events: [], disabled: true });
      assert.deepEqual(w.provider.calls, []);
      assert.deepEqual(w.lines, []);
    }
  });

  it('a failing provider degrades to an empty, silent read', async () => {
    const w = world();
    await w.publish(landedOnA());
    w.provider.getRepoCommentsSince = async () => {
      throw new Error('502 Bad Gateway');
    };
    const coordination = await surfaceInbox(w.reader);
    assert.deepEqual(coordination.events, []);
    assert.match(coordination.degraded, /^provider-error: 502 Bad Gateway/);
    assert.deepEqual(w.lines, []);
  });

  it('a provider that cannot be built degrades instead of throwing', async () => {
    const w = world();
    const noToken = await surfaceInbox({
      ...w.reader,
      provider: () => {
        throw new Error('no GitHub token\nstack line');
      },
    });
    assert.deepEqual(noToken, {
      events: [],
      degraded: 'unavailable: no GitHub token',
    });
    const missing = await surfaceInbox({ ...w.reader, provider: () => null });
    assert.equal(missing.degraded, 'unavailable: no ticketing provider');
    assert.deepEqual(w.lines, []);
  });

  it('builds the provider from a factory only when the channel is on', async () => {
    const w = world();
    await w.publish(landedOnA());
    let built = 0;
    const provider = () => {
      built += 1;
      return w.provider;
    };
    const read = await surfaceInbox({ ...w.reader, provider });
    assert.deepEqual(summaries(read), ['Sibling landed']);
    await surfaceInbox({
      ...w.reader,
      provider,
      env: { [COORDINATION_DISABLED_ENV]: '1' },
    });
    assert.equal(built, 1);
  });
});

/** A `gh` double answering the PR files read with `filenames`. */
function ghWithFiles(filenames) {
  const endpoints = [];
  return {
    endpoints,
    async api({ method, endpoint }) {
      endpoints.push(`${method} ${endpoint}`);
      return {
        stdout: JSON.stringify(filenames.map((filename) => ({ filename }))),
      };
    },
  };
}

describe('publishLanded', () => {
  const landed = (w, gh, extra = {}) =>
    publishLanded({
      storyId: 8,
      prNumber: 42,
      prUrl: 'https://github.com/octo/demo/pull/42',
      config: w.config,
      provider: w.provider,
      gh,
      env: {},
      now: () => w.clock.now,
      ...extra,
    });

  it('publishes one landed event on the Story, scoped to the PR files and linked to the PR', async () => {
    const w = world();
    const gh = ghWithFiles(['lib/a.js', 'lib/c.js']);
    const result = await landed(w, gh);
    assert.equal(result.published, true);
    assert.equal(result.issueId, 8);
    assert.deepEqual(gh.endpoints, [
      'GET repos/octo/demo/pulls/42/files?per_page=100',
    ]);
    const [event, ...rest] = eventsOn(w.provider);
    assert.deepEqual(rest, []);
    assert.equal(event.kind, 'landed');
    assert.equal(event.issueId, 8);
    assert.deepEqual(event.actor, { storyId: 8 });
    assert.deepEqual(event.scope, {
      paths: ['lib/a.js', 'lib/c.js'],
      stories: [],
      broadcast: false,
    });
    assert.equal(event.link, 'https://github.com/octo/demo/pull/42');
    // It reaches the Story whose footprint the PR touched.
    assert.equal((await surfaceInbox(w.reader)).events.length, 1);
  });

  it('a second publish for the same Story posts nothing', async () => {
    const w = world();
    const gh = ghWithFiles(['lib/a.js']);
    await landed(w, gh);
    const again = await landed(w, gh);
    assert.equal(again.published, false);
    assert.equal(again.skipped, 'exists');
    assert.equal(eventsOn(w.provider).length, 1);
  });

  it('links the PR under the configured repository when no URL is given', async () => {
    const w = world();
    await landed(w, ghWithFiles(['lib/a.js']), { prUrl: undefined });
    assert.equal(
      eventsOn(w.provider)[0].link,
      'https://github.com/octo/demo/pull/42',
    );
  });

  it('broadcasts when the one page of files is full', async () => {
    const w = world();
    const page = Array.from({ length: 100 }, (_, i) => `lib/f${i}.js`);
    await landed(w, ghWithFiles(page));
    assert.equal(eventsOn(w.provider)[0].scope.broadcast, true);
  });

  it('answers degraded, and posts nothing, when the files read or the post fails', async () => {
    const w = world();
    const failingGh = {
      async api() {
        throw new Error('gh: HTTP 502');
      },
    };
    const unread = await landed(w, failingGh);
    assert.equal(unread.degraded, 'unavailable: gh: HTTP 502');
    assert.deepEqual(eventsOn(w.provider), []);

    w.provider.postComment = async () => {
      throw new Error('comments API down');
    };
    const unposted = await landed(w, ghWithFiles(['lib/a.js']));
    assert.match(unposted.degraded, /^provider-error: comments API down/);
  });

  it('reads nothing when the channel is off or no repository is configured', async () => {
    const w = world();
    const gh = ghWithFiles(['lib/a.js']);
    assert.deepEqual(
      await landed(w, gh, { env: { [COORDINATION_DISABLED_ENV]: '1' } }),
      { disabled: true },
    );
    assert.deepEqual(await landed(w, gh, { config: {} }), {
      skipped: 'no-repository',
    });
    assert.deepEqual(gh.endpoints, []);
    assert.deepEqual(eventsOn(w.provider), []);
  });
});

describe('publishPlanChanges', () => {
  const executing = (paths) => ({
    labels: ['type::story', 'agent::executing'],
    body: storyBody({ paths }),
  });
  const IN_FLIGHT = {
    20: executing(['lib/a.js', 'lib/b.js']),
    21: executing(['lib/z.js']),
    22: {
      labels: ['type::story', 'agent::ready'],
      body: storyBody({ paths: ['lib/a.js'] }),
    },
  };
  const planned = (id, paths, extra = {}) => ({
    id,
    body: storyBody({ paths }),
    ...extra,
  });
  const announce = (w, stories) =>
    publishPlanChanges({
      stories,
      config: w.config,
      provider: w.provider,
      env: {},
      now: () => w.clock.now,
    });

  it('publishes one event per colliding Story, naming the in-flight Stories and the paths', async () => {
    const w = world({ tickets: IN_FLIGHT });
    const result = await announce(w, [
      planned(30, ['lib/a.js', 'lib/new.js']),
      planned(31, ['lib/q.js']),
    ]);
    assert.deepEqual(result, { published: [30], warnings: [] });
    const [event, ...rest] = eventsOn(w.provider);
    assert.deepEqual(rest, []);
    assert.equal(event.kind, 'plan-change');
    assert.equal(event.issueId, 30);
    assert.deepEqual(event.scope, {
      paths: ['lib/a.js'],
      stories: [20],
      broadcast: false,
    });
    assert.equal(event.link, 'https://github.com/octo/demo/issues/30');
    // The in-flight Story it names reads it; the unrelated one does not.
    const reader = { config: w.config, provider: w.provider, ...w.overrides };
    assert.equal(
      (await surfaceInbox({ ...reader, storyId: 20 })).events.length,
      1,
    );
    assert.deepEqual(await surfaceInbox({ ...reader, storyId: 21 }), {
      events: [],
    });
  });

  it('names every in-flight Story a plan collides with, and the union of their paths', async () => {
    const w = world({ tickets: IN_FLIGHT });
    await announce(w, [planned(30, ['lib/z.js', 'lib/b.js'])]);
    assert.deepEqual(eventsOn(w.provider)[0].scope, {
      paths: ['lib/b.js', 'lib/z.js'],
      stories: [20, 21],
      broadcast: false,
    });
  });

  it('publishes nothing without a collision, and never for a Story against itself', async () => {
    const w = world({ tickets: IN_FLIGHT });
    const result = await announce(w, [
      planned(31, ['lib/q.js']),
      // A rewritten Story that is itself in flight.
      planned(21, ['lib/z.js']),
    ]);
    assert.deepEqual(result, { published: [], warnings: [] });
    assert.ok(!w.provider.calls.includes('postComment'));
  });

  it('does not treat an unparseable in-flight body as overlapping everything', async () => {
    const w = world({
      tickets: {
        20: { labels: ['agent::executing'], body: '## Changes\n- not a path' },
      },
    });
    const result = await announce(w, [planned(30, ['lib/a.js'])]);
    assert.deepEqual(result, { published: [], warnings: [] });
  });

  it('reports a failed publish as a warning and keeps going', async () => {
    const w = world({ tickets: IN_FLIGHT });
    w.provider.postComment = async () => {
      throw new Error('comments API down');
    };
    const result = await announce(w, [planned(30, ['lib/a.js'])]);
    assert.deepEqual(result.published, []);
    assert.equal(result.warnings.length, 1);
    assert.match(
      result.warnings[0],
      /plan-change event for Story #30 was not published: provider-error: comments API down/,
    );
  });

  it('reports an unreadable in-flight list as one warning', async () => {
    const w = world({ tickets: IN_FLIGHT });
    w.provider.listTicketsByLabel = async () => {
      throw new Error('search API down');
    };
    const result = await announce(w, [planned(30, ['lib/a.js'])]);
    assert.deepEqual(result.published, []);
    assert.deepEqual(result.warnings, [
      '[plan-persist] plan-change events were not published: unavailable: search API down',
    ]);
  });

  it('is silent when the channel is off or the provider cannot list Stories', async () => {
    const w = world({ tickets: IN_FLIGHT });
    w.provider.calls.length = 0;
    const off = await publishPlanChanges({
      stories: [planned(30, ['lib/a.js'])],
      config: w.config,
      provider: w.provider,
      env: { [COORDINATION_DISABLED_ENV]: '1' },
    });
    assert.deepEqual(off, { published: [], warnings: [] });
    assert.deepEqual(w.provider.calls, []);
    const bare = await publishPlanChanges({
      stories: [planned(30, ['lib/a.js'])],
      config: w.config,
      provider: { postComment: w.provider.postComment },
      env: {},
    });
    assert.deepEqual(bare, { published: [], warnings: [] });
  });

  it('a resumed persist publishes for an adopted Story once only', async () => {
    const w = world({ tickets: IN_FLIGHT });
    const adopted = [planned(30, ['lib/a.js'], { adopted: true })];
    assert.deepEqual((await announce(w, adopted)).published, [30]);
    assert.deepEqual(await announce(w, adopted), {
      published: [],
      warnings: [],
    });
    assert.equal(eventsOn(w.provider).length, 1);
  });
});

describe('single-story-init surfaces the inbox', () => {
  /** `runSingleStoryInit` arguments over the world's provider and config. */
  function initArgs(w) {
    w.provider.updateTicket = async () => {};
    return {
      storyId: 7,
      injectedProvider: w.provider,
      injectedConfig: {
        ...w.config,
        github: { ...w.config.github, operatorHandle: '@alice' },
      },
      injectedVerifyRemote: () => ({
        remoteVerified: true,
        remoteUrl: 'https://github.com/octo/demo.git',
        detail: 'ok',
      }),
      injectedAcquireLease: async () => ({
        acquired: true,
        owner: 'alice',
        previousOwner: null,
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
      injectedCoordination: w.overrides,
    };
  }
  const withoutInbox = ({ coordination: _coordination, ...rest }) => rest;

  it('starts the cursor, prints the block, and carries the events in the init result', async () => {
    const w = world();
    await w.publish(landedOnA());
    const { success, result } = await runSingleStoryInit(initArgs(w));
    assert.equal(success, true);
    assert.deepEqual(summaries(result.coordination), ['Sibling landed']);
    assert.match(w.lines[0], /1 pertinent event\(s\)/);
    // The default read advanced the cursor: the event is now seen.
    assert.deepEqual(await surfaceInbox(w.reader), { events: [] });
  });

  it('an event, a degraded channel and a disabled one leave the rest of the result alike', async () => {
    const quiet = world();
    const baseline = await runSingleStoryInit(initArgs(quiet));
    assert.deepEqual(baseline.result.coordination, { events: [] });

    const eventful = world();
    await eventful.publish(landedOnA());
    const degraded = world();
    degraded.provider.getRepoCommentsSince = async () => {
      throw new Error('502 Bad Gateway');
    };
    const disabled = world();
    disabled.overrides.env = { [COORDINATION_DISABLED_ENV]: '1' };

    for (const w of [eventful, degraded, disabled]) {
      const run = await runSingleStoryInit(initArgs(w));
      assert.equal(run.success, true);
      assert.deepEqual(
        { ...withoutInbox(run.result), runScopedConfig: null },
        { ...withoutInbox(baseline.result), runScopedConfig: null },
      );
    }
    assert.deepEqual(degraded.lines, []);
    assert.deepEqual(disabled.lines, []);
  });

  it('a dry run reads nothing', async () => {
    const w = world();
    await w.publish(landedOnA());
    w.provider.calls.length = 0;
    const { result } = await runSingleStoryInit({
      ...initArgs(w),
      dryRun: true,
    });
    assert.equal(result.coordination, null);
    assert.ok(!w.provider.calls.includes('getRepoCommentsSince'));
  });
});
