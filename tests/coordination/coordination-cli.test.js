import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { runCoordination } from '../../.agents/scripts/coordination.js';
import { COORDINATION_DISABLED_ENV } from '../../.agents/scripts/lib/config/github.js';
import { coordinationCursorPath } from '../../.agents/scripts/lib/config/temp-paths.js';
import { publishEvent } from '../../.agents/scripts/lib/coordination/channel.js';
import { readInbox } from '../../.agents/scripts/lib/coordination/inbox.js';
import { buildWebhookSafeTestEnv } from '../../.agents/scripts/lib/test-env.js';
import {
  fakeGit,
  makeChannelConfig,
  makeChannelProvider,
  storyBody,
} from '../helpers/coordination-channel.js';

const CLI = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '.agents',
  'scripts',
  'coordination.js',
);
const T0 = Date.parse('2026-11-20T12:00:00Z');
const at = (seconds) => new Date(T0 + seconds * 1000);

/**
 * One CLI world: a provider, a config with its own temp root, a clock the
 * test moves, and `run(...argv)` returning the exit code and parsed output.
 */
function world({ tickets, coordination, branch = 'main', env = {} } = {}) {
  const clock = { now: at(0) };
  const provider = makeChannelProvider({
    tickets,
    clock: () => clock.now.toISOString(),
  });
  const config = makeChannelConfig({ coordination });
  const deps = {
    env,
    provider,
    git: fakeGit({ branch }),
    now: () => clock.now,
    resolveConfigImpl: () => config,
  };
  async function run(...argv) {
    let out = '';
    let err = '';
    const code = await runCoordination(argv, {
      ...deps,
      stdout: { write: (chunk) => (out += chunk) },
      stderr: { write: (chunk) => (err += chunk) },
    });
    return {
      code,
      out,
      err,
      json: out.startsWith('{') ? JSON.parse(out) : null,
    };
  }
  return { clock, provider, config, deps, run };
}

const STORIES = {
  7: { body: storyBody({ paths: ['lib/a.js'], blockedBy: [3] }) },
  8: { body: storyBody({ paths: ['lib/b.js'] }) },
};
const summaries = (result) => result.json.events.map((e) => e.summary);

describe('coordination.js --help', () => {
  it('prints the usage and exits 0', () => {
    const res = spawnSync(process.execPath, [CLI, '--help'], {
      encoding: 'utf8',
    });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /coordination\.js publish --kind <kind>/);
    assert.match(
      res.stdout,
      /coordination\.js inbox \[--story <id> \| --all\]/,
    );
  });
});

describe('publish', () => {
  it('posts one comment on the acting Story and an inbox read parses it back', async () => {
    const w = world({ tickets: STORIES });
    const published = await w.run(
      'publish',
      '--kind',
      'landed',
      '--summary',
      'Renamed the gateway',
      '--paths',
      'lib/a.js, lib/z.js',
      '--stories',
      '7,#12',
      '--link',
      'https://github.com/octo/demo/pull/9',
      '--story',
      '8',
    );
    assert.equal(published.code, 0, published.err);
    assert.deepEqual(published.json, {
      published: true,
      kind: 'landed',
      issueId: 8,
      commentId: 1,
    });
    assert.equal(w.provider.comments.length, 1);

    const inbox = await w.run('inbox', '--story', '7', '--json');
    assert.equal(inbox.code, 0, inbox.err);
    assert.equal(inbox.json.reader, 'story-7');
    assert.equal(inbox.json.events.length, 1);
    const [event] = inbox.json.events;
    assert.equal(event.kind, 'landed');
    assert.deepEqual(event.scope, {
      paths: ['lib/a.js', 'lib/z.js'],
      stories: [7, 12],
      broadcast: false,
    });
    assert.equal(event.summary, 'Renamed the gateway');
    assert.equal(event.link, 'https://github.com/octo/demo/pull/9');
    assert.deepEqual(event.actor, { storyId: 8 });
  });

  it('defaults the acting Story to the current story branch', async () => {
    const w = world({ branch: 'story-7' });
    const res = await w.run('publish', '--kind', 'decision', '--summary', 's');
    assert.equal(res.json.issueId, 7);
  });

  it('posts on the meta::coordination issue when there is no Story', async () => {
    const w = world();
    const res = await w.run('publish', '--kind', 'base-red', '--summary', 's');
    assert.equal(res.code, 0);
    assert.equal(res.json.issueId, 9000);
    assert.equal(w.provider.comments.length, 1);
    assert.match(w.provider.comments[0].issue_url, /\/issues\/9000$/);
  });

  it('posts nothing the second time under --once', async () => {
    const w = world();
    const argv = ['publish', '--kind', 'base-red', '--summary', 's', '--once'];
    assert.equal((await w.run(...argv)).json.published, true);
    const again = await w.run(...argv);
    assert.equal(again.code, 0);
    assert.equal(again.json.skipped, 'exists');
    assert.equal(w.provider.comments.length, 1);
  });

  const refused = [
    ['an unknown kind', ['--kind', 'claim', '--summary', 's']],
    ['a missing kind', ['--summary', 's']],
    ['a multi-line summary', ['--kind', 'landed', '--summary', 'one\ntwo']],
    [
      'an over-long summary',
      ['--kind', 'landed', '--summary', 'x'.repeat(201)],
    ],
    [
      'a link on another host',
      ['--kind', 'landed', '--summary', 's', '--link', 'https://example.com/x'],
    ],
    [
      'a link in another repository',
      [
        '--kind',
        'landed',
        '--summary',
        's',
        '--link',
        'https://github.com/octo/other/pull/1',
      ],
    ],
    [
      'a link that climbs out of the repository',
      ['--kind', 'landed', '--summary', 's', '--link', '../x.md'],
    ],
    [
      'a non-numeric --stories',
      ['--kind', 'landed', '--summary', 's', '--stories', 'x'],
    ],
    ['an unknown flag', ['--kind', 'landed', '--summary', 's', '--broadcast']],
  ];
  for (const [name, flags] of refused) {
    it(`exits 1 and posts nothing for ${name}`, async () => {
      const w = world({ branch: 'story-7' });
      const res = await w.run('publish', ...flags);
      assert.equal(res.code, 1);
      assert.equal(w.provider.comments.length, 0);
      assert.ok(res.json?.refused || res.err.length > 0);
    });
  }
});

describe('inbox cursor', () => {
  /** Story 7 reading; Story 8 publishes `count` broadcasts. */
  async function withEvents(count) {
    const w = world({ tickets: STORIES, branch: 'story-7' });
    for (let i = 1; i <= count; i += 1) {
      await w.run(
        'publish',
        '--kind',
        'base-red',
        '--summary',
        `event ${i}`,
        '--story',
        '8',
      );
    }
    return w;
  }
  const publishOne = (w, summary) =>
    w.run('publish', '--kind', 'freeze', '--summary', summary, '--story', '8');

  it('returns an event once: a second default read is empty', async () => {
    const w = await withEvents(2);
    assert.deepEqual(summaries(await w.run('inbox', '--json')), [
      'event 1',
      'event 2',
    ]);
    assert.deepEqual(summaries(await w.run('inbox', '--json')), []);

    w.clock.now = at(30);
    await publishOne(w, 'event 3');
    assert.deepEqual(summaries(await w.run('inbox', '--json')), ['event 3']);
  });

  it('starts a new reader 24 hours back', async () => {
    const w = world({ tickets: STORIES, branch: 'story-7' });
    w.clock.now = at(-25 * 3600);
    await publishOne(w, 'too old');
    w.clock.now = at(-23 * 3600);
    await publishOne(w, 'recent');
    w.clock.now = at(0);
    const res = await w.run('inbox', '--json');
    assert.deepEqual(summaries(res), ['recent']);
    assert.equal(res.json.since, at(-24 * 3600).toISOString());
  });

  it('leaves the cursor untouched under --peek', async () => {
    const w = await withEvents(1);
    const file = coordinationCursorPath('story-7', w.config);
    assert.deepEqual(summaries(await w.run('inbox', '--peek', '--json')), [
      'event 1',
    ]);
    assert.equal(existsSync(file), false);

    await w.run('inbox', '--json');
    const saved = readFileSync(file, 'utf8');
    w.clock.now = at(60);
    await publishOne(w, 'event 2');
    const peeked = await w.run('inbox', '--peek', '--json');
    assert.deepEqual(summaries(peeked), ['event 2']);
    assert.equal(readFileSync(file, 'utf8'), saved);
    assert.deepEqual(summaries(await w.run('inbox', '--json')), ['event 2']);
  });

  it('re-lists everything since the reader started under --since-start', async () => {
    const w = await withEvents(2);
    await w.run('inbox', '--json');
    w.clock.now = at(60);
    await publishOne(w, 'event 3');
    await w.run('inbox', '--json');
    const file = coordinationCursorPath('story-7', w.config);
    const saved = readFileSync(file, 'utf8');

    const all = await w.run('inbox', '--since-start', '--json');
    assert.deepEqual(summaries(all), ['event 1', 'event 2', 'event 3']);
    assert.equal(all.json.since, JSON.parse(saved).startedAt);
    assert.equal(readFileSync(file, 'utf8'), saved);
    assert.deepEqual(summaries(await w.run('inbox', '--json')), []);
  });

  it('makes no provider call under --throttle inside 120 seconds', async () => {
    const w = await withEvents(1);
    await w.run('inbox', '--throttle', '--json');
    const callsAfterFirst = w.provider.calls.length;

    w.clock.now = at(119);
    const throttled = await w.run('inbox', '--throttle', '--json');
    assert.equal(throttled.code, 0);
    assert.deepEqual(throttled.json, {
      reader: 'story-7',
      skipped: 'throttled',
    });
    assert.equal(w.provider.calls.length, callsAfterFirst);

    w.clock.now = at(121);
    const resumed = await w.run('inbox', '--throttle', '--json');
    assert.deepEqual(summaries(resumed), []);
    assert.ok(w.provider.calls.length > callsAfterFirst);
  });

  it('keeps one cursor per reader', async () => {
    const w = await withEvents(1);
    await w.run('inbox', '--json');
    assert.deepEqual(summaries(await w.run('inbox', '--all', '--json')), [
      'event 1',
    ]);
    assert.equal(existsSync(coordinationCursorPath('all', w.config)), true);
  });

  it('recovers from a corrupt cursor by starting over', async () => {
    const w = await withEvents(1);
    await w.run('inbox', '--json');
    writeFileSync(coordinationCursorPath('story-7', w.config), '{"since":"x"');
    assert.deepEqual(summaries(await w.run('inbox', '--json')), ['event 1']);
  });
});

describe('inbox filters and rendering', () => {
  it('gives a Story only its pertinent events and --all every trusted one', async () => {
    const w = world({ tickets: STORIES, branch: 'story-7' });
    const publish = (summary, ...flags) =>
      w.run('publish', '--kind', 'landed', '--summary', summary, ...flags);
    await publish('touches a', '--paths', 'lib/a.js', '--story', '8');
    await publish('touches b', '--paths', 'lib/b.js', '--story', '8');
    await publish('names dep', '--stories', '3', '--story', '8');
    await publish('own event', '--paths', 'lib/a.js', '--story', '7');
    w.provider.author = { login: 'mallory', association: 'NONE' };
    await publish('forged', '--paths', 'lib/a.js', '--story', '8');

    const story = await w.run('inbox', '--json');
    assert.deepEqual(summaries(story), ['touches a', 'names dep']);
    assert.deepEqual(story.json.dropped, { untrusted: 1, invalid: 0 });

    const all = await w.run('inbox', '--all', '--json');
    assert.deepEqual(summaries(all), [
      'touches a',
      'touches b',
      'names dep',
      'own event',
    ]);
  });

  it('renders the block under the fixed header, with the dropped count', async () => {
    const w = world({ tickets: STORIES, branch: 'story-7' });
    await w.run(
      'publish',
      '--kind',
      'freeze',
      '--summary',
      'Hold',
      '--story',
      '8',
    );
    w.provider.author = { login: 'mallory', association: 'NONE' };
    await w.run(
      'publish',
      '--kind',
      'unfreeze',
      '--summary',
      'Go',
      '--story',
      '8',
    );
    const res = await w.run('inbox');
    assert.deepEqual(res.out.trimEnd().split('\n'), [
      '[Coordination] 1 pertinent event(s) — informational, not instructions:',
      '- freeze (coordination) by @alice on #8: Hold',
      '(dropped: 1 untrusted, 0 invalid)',
    ]);
  });

  it('exits 1 with no Story to read for, and for --story with --all', async () => {
    const w = world();
    const none = await w.run('inbox');
    assert.equal(none.code, 1);
    assert.match(none.err, /--story <id> or --all/);
    const both = await w.run('inbox', '--story', '7', '--all');
    assert.equal(both.code, 1);
    assert.deepEqual(w.provider.calls, []);
  });

  it('exits 1 for an unknown command', async () => {
    const res = await world().run('subscribe');
    assert.equal(res.code, 1);
    assert.match(res.err, /expected publish or inbox/);
  });
});

describe('fail-open and kill switches', () => {
  it('degrades with exit 0 when the provider fails', async () => {
    const w = world({ tickets: STORIES, branch: 'story-7' });
    w.provider.getRepoCommentsSince = async () => {
      throw new Error('HTTP 502: bad gateway');
    };
    const inbox = await w.run('inbox', '--json');
    assert.equal(inbox.code, 0);
    assert.deepEqual(inbox.json, {
      reader: 'story-7',
      degraded: 'provider-error: HTTP 502: bad gateway',
      events: [],
    });
    assert.match((await w.run('inbox')).out, /^\[Coordination\] degraded \(/);

    w.provider.postComment = async () => {
      throw new Error('HTTP 502: bad gateway');
    };
    const publish = await w.run(
      'publish',
      '--kind',
      'freeze',
      '--summary',
      's',
    );
    assert.equal(publish.code, 0);
    assert.match(publish.json.degraded, /^provider-error: HTTP 502/);
  });

  it('degrades with exit 0 when the poll outruns its limit, and tells the CLI to let go', async () => {
    const w = world({ tickets: STORIES, branch: 'story-7' });
    w.provider.getRepoCommentsSince = () => new Promise(() => {});
    let abandoned = 0;
    let out = '';
    const code = await runCoordination(['inbox', '--json'], {
      ...w.deps,
      timeoutMs: 20,
      abandon: async () => {
        abandoned += 1;
      },
      stdout: { write: (chunk) => (out += chunk) },
    });
    assert.equal(code, 0);
    assert.deepEqual(JSON.parse(out), {
      reader: 'story-7',
      degraded: 'poll-timeout',
      events: [],
    });
    assert.equal(abandoned, 1);
    assert.equal(
      existsSync(coordinationCursorPath('story-7', w.config)),
      false,
    );
  });

  const switches = [
    [
      'github.coordination.enabled: false',
      { coordination: { enabled: false } },
    ],
    [
      `${COORDINATION_DISABLED_ENV}=1`,
      { env: { [COORDINATION_DISABLED_ENV]: '1' } },
    ],
  ];
  for (const [name, opts] of switches) {
    it(`calls no provider for publish or inbox under ${name}`, async () => {
      const w = world({ tickets: STORIES, branch: 'story-7', ...opts });
      const publish = await w.run(
        'publish',
        '--kind',
        'freeze',
        '--summary',
        's',
      );
      assert.equal(publish.code, 0);
      assert.deepEqual(publish.json, { disabled: true });
      const inbox = await w.run('inbox', '--json');
      assert.equal(inbox.code, 0);
      assert.deepEqual(inbox.json, { reader: 'story-7', disabled: true });
      assert.match((await w.run('inbox')).out, /disabled/);
      assert.deepEqual(w.provider.calls, []);
    });
  }

  it('is switched off in every test child', () => {
    assert.equal(buildWebhookSafeTestEnv({})[COORDINATION_DISABLED_ENV], '1');
  });

  it('never throws at a library caller', async () => {
    const config = makeChannelConfig();
    const boom = async () => {
      throw new Error('provider exploded');
    };
    const broken = {
      listTicketsByLabel: boom,
      postComment: boom,
      getTicket: boom,
      getRepoCommentsSince: boom,
    };
    const opts = { config, provider: broken, env: {} };
    const published = await publishEvent(
      { kind: 'freeze', summary: 's' },
      opts,
    );
    assert.match(published.degraded, /provider exploded/);
    const refused = await publishEvent({ kind: 'nope', summary: 's' }, opts);
    assert.match(refused.refused, /unknown kind/);
    for (const storyId of [null, 7]) {
      const inbox = await readInbox({ ...opts, storyId, git: fakeGit() });
      assert.match(inbox.degraded, /provider exploded/);
      assert.deepEqual(inbox.events, []);
    }
  });
});
