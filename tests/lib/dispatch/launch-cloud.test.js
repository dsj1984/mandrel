// tests/lib/dispatch/launch-cloud.test.js — the `claude-cloud` target end to
// end through `runDispatch`, over an in-memory board and an injected fetch.
// A sentinel token proves the secret reaches only the request headers.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { runDispatch } from '../../../.agents/scripts/dispatch.js';
import { getAgentrcValidator } from '../../../.agents/scripts/lib/config-settings-schema.js';
import { makeDispatchBoard } from '../../helpers/dispatch-board.js';

const SENTINEL = 'sk-sentinel-7f3a9c-never-print-me';
const SESSION_URL = 'https://claude.ai/code/session_01abc';
const CLOUD = {
  target: 'claude-cloud',
  routine: 'trig_01Abc_def',
  tokenEnv: 'ROUTINE_TOKEN',
};
const CONFIG = {
  github: { operatorHandle: '@me' },
  delivery: { environments: { cloud: CLOUD } },
};

const ready = (id, extra = []) => ({
  id,
  labels: ['type::story', 'agent::ready', ...extra],
});

const ok = () =>
  new Response(
    JSON.stringify({
      type: 'routine_fire',
      claude_code_session_id: 'session_01abc',
      claude_code_session_url: SESSION_URL,
    }),
    { status: 200 },
  );

/**
 * Run dispatch with a fake fetch; capture the envelope, every byte written to
 * the real stdout/stderr meanwhile, the requests and the posted comments.
 */
async function run(
  argv,
  { respond = ok, tickets, env, records, postComment } = {},
) {
  const board = makeDispatchBoard(tickets ?? [ready(7)]);
  for (const [id, record] of records ?? []) board.records.set(id, record);
  const comments = [];
  const requests = [];
  const { out, deps } = board.capture();
  const streams = [];
  const originals = [process.stdout.write, process.stderr.write];
  process.stdout.write = (chunk, ...rest) => {
    streams.push(String(chunk));
    return originals[0].call(process.stdout, chunk, ...rest);
  };
  process.stderr.write = (chunk, ...rest) => {
    streams.push(String(chunk));
    return originals[1].call(process.stderr, chunk, ...rest);
  };
  let code;
  try {
    code = await runDispatch(argv, {
      ...deps,
      config: CONFIG,
      env: env ?? { ROUTINE_TOKEN: SENTINEL },
      provider: {
        ...deps.provider,
        async postComment(id, payload) {
          if (postComment) return postComment();
          comments.push({ id, body: payload.body });
        },
      },
      fetchImpl: async (url, init) => {
        requests.push({ url, ...init });
        return respond();
      },
    });
  } finally {
    [process.stdout.write, process.stderr.write] = originals;
  }
  const text = out.join('');
  return {
    code,
    envelope: JSON.parse(text),
    board,
    comments,
    requests,
    exposed: [
      text,
      ...streams,
      JSON.stringify([...board.records.values()]),
      JSON.stringify(comments),
      JSON.stringify(board.writes),
    ].join('\n'),
  };
}

const assertNoSentinel = (result) =>
  assert.equal(result.exposed.includes(SENTINEL), false, 'sentinel leaked');

describe('cloud environment schema (AC-1)', () => {
  const validate = getAgentrcValidator();
  const check = (entry) =>
    validate({
      project: {
        paths: { agentRoot: '.agents', docsRoot: 'docs', tempRoot: 'temp' },
      },
      delivery: { environments: { cloud: entry } },
    });

  it('accepts a cloud entry naming its routine and token variable', () => {
    assert.equal(check(CLOUD), true, JSON.stringify(validate.errors));
    assert.equal(check({ ...CLOUD, capacity: 3 }), true);
  });

  const rejects = {
    'a missing routine': { target: 'claude-cloud', tokenEnv: 'ROUTINE_TOKEN' },
    'a missing token variable': { target: 'claude-cloud', routine: 'trig_1' },
    'a launch command': { ...CLOUD, command: ['claude'] },
    'a malformed routine id': { ...CLOUD, routine: 'routine_1' },
    'a malformed variable name': { ...CLOUD, tokenEnv: 'routine-token' },
    'a literal token in place of a name': { ...CLOUD, tokenEnv: SENTINEL },
  };
  for (const [name, entry] of Object.entries(rejects)) {
    it(`rejects ${name}`, () => assert.equal(check(entry), false));
  }
});

describe('fire request (AC-2, AC-4)', () => {
  it('sends the documented request once, records the session and comments once', async () => {
    const result = await run(['--env', 'cloud', '7']);
    assert.equal(result.code, 0);
    assert.deepEqual(result.requests, [
      {
        url: 'https://api.anthropic.com/v1/claude_code/routines/trig_01Abc_def/fire',
        method: 'POST',
        headers: {
          Authorization: `Bearer ${SENTINEL}`,
          'anthropic-version': '2023-06-01',
          'anthropic-beta': 'experimental-cc-routine-2026-04-01',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ text: 'mandrel-deliver 7' }),
      },
    ]);
    assert.deepEqual(result.envelope, {
      ok: true,
      action: 'dispatch',
      storyId: 7,
      environment: 'cloud',
      launchOptions: {
        model: { value: null, source: 'routine' },
        effort: { value: null, source: 'routine' },
      },
      sessionUrl: SESSION_URL,
      commentPosted: true,
    });
    const record = result.board.records.get(7);
    assert.equal(record.sessionId, 'session_01abc');
    assert.equal(record.sessionUrl, SESSION_URL);
    assert.equal(result.comments.length, 1);
    assert.match(result.comments[0].body, /`cloud`/);
    assert.ok(result.comments[0].body.includes(SESSION_URL));
    assert.ok(result.board.store.get(7).labels.includes('env::cloud'));
    assert.equal(result.board.launches.length, 0, 'no local launch');
    assertNoSentinel(result);
  });
});

describe('failed comment after a fire', () => {
  it('keeps the label and the record, and reports the comment unposted', async () => {
    const result = await run(['--env', 'cloud', '7'], {
      postComment: async () => {
        throw new Error('gh 502');
      },
    });
    assert.equal(result.code, 0);
    assert.equal(result.envelope.sessionUrl, SESSION_URL);
    assert.equal(result.envelope.commentPosted, false);
    assert.ok(result.board.store.get(7).labels.includes('env::cloud'));
    assert.equal(result.board.records.get(7).sessionUrl, SESSION_URL);
    assertNoSentinel(result);
  });
});

describe('failed fires (AC-3, AC-5, AC-6)', () => {
  it('a non-2xx removes the label and exits 1 with launch-failed, once', async () => {
    const result = await run(['--env', 'cloud', '7'], {
      respond: () => new Response(`bad token ${SENTINEL}`, { status: 401 }),
    });
    assert.equal(result.code, 1);
    assert.equal(result.envelope.reason, 'launch-failed');
    assert.equal(result.envelope.status, 401);
    assert.equal(result.requests.length, 1);
    assert.equal(
      result.board.store.get(7).labels.includes('env::cloud'),
      false,
    );
    assert.equal(result.comments.length, 0);
    assert.equal(result.board.records.has(7), false);
    assertNoSentinel(result);
  });

  it('a 429 reports rate-limited with the Retry-After value, once', async () => {
    const result = await run(['--env', 'cloud', '7'], {
      respond: () =>
        new Response('', { status: 429, headers: { 'retry-after': '120' } }),
    });
    assert.equal(result.code, 1);
    assert.equal(result.envelope.reason, 'rate-limited');
    assert.equal(result.envelope.retryAfter, '120');
    assert.equal(result.requests.length, 1);
    assert.equal(
      result.board.store.get(7).labels.includes('env::cloud'),
      false,
    );
    assertNoSentinel(result);
  });

  it('a network failure keeps the label and exits 1 with launch-unconfirmed', async () => {
    const result = await run(['--env', 'cloud', '7'], {
      respond: () => {
        throw new TypeError(`fetch failed for Bearer ${SENTINEL}`);
      },
    });
    assert.equal(result.code, 1);
    assert.equal(result.envelope.reason, 'launch-unconfirmed');
    assert.equal(result.requests.length, 1);
    assert.ok(result.board.store.get(7).labels.includes('env::cloud'));
    assertNoSentinel(result);
  });

  it('a success body without a session URL is unconfirmed, label kept', async () => {
    const result = await run(['--env', 'cloud', '7'], {
      respond: () => new Response('not json', { status: 200 }),
    });
    assert.equal(result.code, 1);
    assert.equal(result.envelope.reason, 'launch-unconfirmed');
    assert.ok(result.board.store.get(7).labels.includes('env::cloud'));
    assertNoSentinel(result);
  });
});

describe('--stop on a cloud Story (AC-7)', () => {
  it('releases lease and labels, prints the session URL and reports a manual stop', async () => {
    const result = await run(['--stop', '7'], {
      tickets: [
        {
          id: 7,
          labels: ['type::story', 'agent::executing', 'env::cloud'],
          assignees: ['me'],
        },
      ],
      records: [[7, { storyId: 7, sessionUrl: SESSION_URL }]],
    });
    assert.equal(result.code, 0);
    assert.equal(result.envelope.remoteStop, 'manual');
    assert.equal(result.envelope.sessionUrl, SESSION_URL);
    assert.match(result.envelope.detail, /archive/);
    const t = result.board.store.get(7);
    assert.deepEqual(t.assignees, []);
    assert.deepEqual(t.labels, ['type::story', 'agent::ready']);
    assert.deepEqual(result.board.kills, []);
    assert.equal(result.requests.length, 0);
  });
});

describe('offline environment (AC-8)', () => {
  it('status reports missing-token and dispatch is refused with offline', async () => {
    const status = await run(['--status', '--json'], { env: {} });
    const cloud = status.envelope.environments.find((e) => e.name === 'cloud');
    assert.equal(cloud.online, false);
    assert.equal(cloud.offlineReason, 'missing-token');

    const result = await run(['--env', 'cloud', '7'], {
      env: { ROUTINE_TOKEN: '' },
    });
    assert.equal(result.code, 2);
    assert.equal(result.envelope.reason, 'offline');
    assert.match(result.envelope.detail, /missing-token/);
    assert.equal(result.requests.length, 0);
    assert.equal(
      result.board.store.get(7).labels.includes('env::cloud'),
      false,
    );
  });
});

describe('--dry-run (AC-9)', () => {
  it('prints the request with the Authorization value redacted and sends nothing', async () => {
    const result = await run(['--env', 'cloud', '--dry-run', '7']);
    assert.equal(result.code, 0);
    assert.equal(result.envelope.dryRun, true);
    const { request } = result.envelope;
    assert.equal(
      request.url,
      'https://api.anthropic.com/v1/claude_code/routines/trig_01Abc_def/fire',
    );
    assert.equal(request.headers.Authorization, '[redacted]');
    assert.equal(request.body, JSON.stringify({ text: 'mandrel-deliver 7' }));
    assert.equal(result.requests.length, 0);
    assertNoSentinel(result);
  });
});
