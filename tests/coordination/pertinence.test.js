import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createChannel } from '../../.agents/scripts/lib/coordination/channel.js';
import {
  buildEvent,
  encodeEventComment,
} from '../../.agents/scripts/lib/coordination/event.js';
import {
  isPertinent,
  isTrustedComment,
  resolveReader,
  storyIdFromBranch,
} from '../../.agents/scripts/lib/coordination/pertinence.js';
import {
  fakeGit,
  makeChannelConfig,
  makeChannelProvider,
  storyBody,
} from '../helpers/coordination-channel.js';

const GITHUB = { owner: 'octo', repo: 'demo' };
const SINCE = '2026-11-19T00:00:00Z';
const event = (input) =>
  buildEvent({ summary: 'an event', ...input }, { github: GITHUB });
const by = (login, association) => ({
  user: { login },
  author_association: association,
});

describe('isTrustedComment', () => {
  for (const association of ['OWNER', 'MEMBER', 'COLLABORATOR']) {
    it(`trusts an ${association}`, () => {
      assert.equal(isTrustedComment(by('alice', association)), true);
    });
  }

  for (const association of [
    'CONTRIBUTOR',
    'FIRST_TIME_CONTRIBUTOR',
    'NONE',
    undefined,
  ]) {
    it(`does not trust ${association ?? 'a missing association'}`, () => {
      assert.equal(isTrustedComment(by('mallory', association)), false);
    });
  }

  it('lets a non-empty trustedAuthors replace the association rule', () => {
    const allow = ['Release-Bot'];
    assert.equal(isTrustedComment(by('release-bot', 'NONE'), allow), true);
    assert.equal(isTrustedComment(by('alice', 'OWNER'), allow), false);
    assert.equal(
      isTrustedComment({ author_association: 'OWNER' }, allow),
      false,
    );
  });
});

describe('poll drops what it cannot trust or read', () => {
  /** One trusted event, one untrusted event, one trusted but invalid. */
  function seeded() {
    const provider = makeChannelProvider();
    const body = (summary) =>
      encodeEventComment(event({ kind: 'base-red', summary }));
    provider.add(7, body('trusted'));
    provider.author = { login: 'mallory', association: 'NONE' };
    provider.add(7, body('forged'));
    provider.author = { login: 'alice', association: 'MEMBER' };
    provider.add(7, body('broken').replace('"v":1', '"v":9'));
    provider.add(7, 'an ordinary comment');
    return provider;
  }

  it('returns only the trusted, valid event and counts the rest', async () => {
    const channel = createChannel({
      provider: seeded(),
      config: makeChannelConfig(),
    });
    const { events, dropped } = await channel.poll(SINCE);
    assert.deepEqual(
      events.map((e) => e.summary),
      ['trusted'],
    );
    assert.deepEqual(dropped, { untrusted: 1, invalid: 1 });
  });

  it('reads only the listed logins when trustedAuthors is set', async () => {
    const channel = createChannel({
      provider: seeded(),
      config: makeChannelConfig({
        coordination: { trustedAuthors: ['MALLORY'] },
      }),
    });
    const { events, dropped } = await channel.poll(SINCE);
    assert.deepEqual(
      events.map((e) => [e.author, e.summary]),
      [['mallory', 'forged']],
    );
    assert.deepEqual(dropped, { untrusted: 2, invalid: 0 });
  });

  it('never takes the author from the payload', async () => {
    const provider = makeChannelProvider();
    provider.author = { login: 'mallory', association: 'NONE' };
    provider.add(
      7,
      encodeEventComment(event({ kind: 'freeze' })).replace(
        '"v":1',
        '"v":1,"author":"alice"',
      ),
    );
    const channel = createChannel({ provider, config: makeChannelConfig() });
    const { events, dropped } = await channel.poll(SINCE);
    assert.deepEqual(events, []);
    assert.deepEqual(dropped, { untrusted: 1, invalid: 0 });
  });
});

describe('isPertinent', () => {
  const reader = {
    storyId: 7,
    dependsOn: [3],
    footprint: ['lib/coordination/channel.js', 'docs/**'],
  };
  const cases = [
    ['a broadcast', { kind: 'base-red' }, true],
    ['an event naming the Story', { kind: 'landed', stories: [7] }, true],
    ['an event naming a dependency', { kind: 'landed', stories: [3] }, true],
    ['an event naming other Stories', { kind: 'landed', stories: [8] }, false],
    [
      'a path the Story declares',
      { kind: 'landed', paths: ['lib/coordination/channel.js'] },
      true,
    ],
    [
      'a glob covering a declared path',
      { kind: 'plan-change', paths: ['lib/coordination/**'] },
      true,
    ],
    [
      'a path under a declared glob',
      { kind: 'decision', paths: ['docs/decisions.md'] },
      true,
    ],
    [
      'a path outside the footprint',
      { kind: 'decision', paths: ['bin/mandrel.js'] },
      false,
    ],
    ['its own broadcast', { kind: 'base-red', storyId: 7 }, false],
    [
      'its own scoped event',
      { kind: 'landed', stories: [7], storyId: 7 },
      false,
    ],
    [
      'a dependency’s own event that names it',
      { kind: 'landed', stories: [7], storyId: 3 },
      true,
    ],
  ];
  for (const [name, input, expected] of cases) {
    it(`${expected ? 'receives' : 'skips'} ${name}`, () => {
      assert.equal(isPertinent(event(input), reader), expected);
    });
  }

  it('gives the --all reader everything, a Story’s own events included', () => {
    const all = { storyId: null, dependsOn: [], footprint: [] };
    for (const input of [
      { kind: 'landed', stories: [8] },
      { kind: 'decision', paths: ['bin/mandrel.js'], storyId: 7 },
    ]) {
      assert.equal(isPertinent(event(input), all), true);
    }
  });

  it('matches nothing on paths for a Story with no footprint', () => {
    const bare = { storyId: 7, dependsOn: [], footprint: [] };
    assert.equal(
      isPertinent(event({ kind: 'landed', paths: ['**'] }), bare),
      false,
    );
  });
});

describe('resolveReader', () => {
  const tickets = {
    7: { body: storyBody({ paths: ['lib/a.js', 'docs/**'], blockedBy: [3] }) },
  };

  it('reads the declared footprint and dependencies off the Story body', async () => {
    const reader = await resolveReader({
      storyId: 7,
      provider: makeChannelProvider({ tickets }),
      config: makeChannelConfig(),
      git: fakeGit({ branch: 'main', changed: ['bin/mandrel.js'] }),
    });
    assert.deepEqual(reader, {
      key: 'story-7',
      storyId: 7,
      dependsOn: [3],
      footprint: ['lib/a.js', 'docs/**'],
    });
  });

  it('adds the changed paths only inside that Story’s worktree', async () => {
    const args = {
      storyId: 7,
      provider: makeChannelProvider({ tickets }),
      config: makeChannelConfig(),
    };
    const inside = await resolveReader({
      ...args,
      git: fakeGit({
        branch: 'story-7',
        changed: ['bin/mandrel.js', 'lib/a.js'],
      }),
    });
    assert.deepEqual(inside.footprint, [
      'lib/a.js',
      'docs/**',
      'bin/mandrel.js',
    ]);
    const sibling = await resolveReader({
      ...args,
      git: fakeGit({ branch: 'story-8', changed: ['bin/mandrel.js'] }),
    });
    assert.deepEqual(sibling.footprint, ['lib/a.js', 'docs/**']);
  });

  it('keeps the declared footprint when the diff cannot be read', async () => {
    const git = {
      gitSpawn: (_cwd, ...args) =>
        args[0] === 'branch'
          ? { status: 0, stdout: 'story-7', stderr: '' }
          : { status: 128, stdout: '', stderr: 'bad revision' },
    };
    const reader = await resolveReader({
      storyId: 7,
      provider: makeChannelProvider({ tickets }),
      config: makeChannelConfig(),
      git,
    });
    assert.deepEqual(reader.footprint, ['lib/a.js', 'docs/**']);
  });

  it('makes no provider call for the --all reader', async () => {
    const provider = makeChannelProvider({ tickets });
    const reader = await resolveReader({ storyId: null, provider });
    assert.equal(reader.key, 'all');
    assert.deepEqual(provider.calls, []);
  });
});

describe('storyIdFromBranch', () => {
  it('parses a Story branch and nothing else', () => {
    assert.equal(
      storyIdFromBranch('.', fakeGit({ branch: 'story-6157' })),
      6157,
    );
    assert.equal(storyIdFromBranch('.', fakeGit({ branch: 'main' })), null);
    assert.equal(
      storyIdFromBranch('.', {
        gitSpawn: () => ({ status: 128, stdout: '', stderr: 'not a repo' }),
      }),
      null,
    );
  });
});
