// tests/cli/ui-server.test.js — `mandrel ui`: the loopback server's
// security invariants, its API over injected state and action functions,
// the sources behind them, and the subcommand entry. No test reaches GitHub
// or starts a process: every source and runner is a fake, and the server
// listens on port 0.

import assert from 'node:assert/strict';
import http from 'node:http';
import { after, beforeEach, describe, it } from 'node:test';

import { runDispatch } from '../../.agents/scripts/dispatch.js';
import {
  isAllowedHost,
  isSameOriginJson,
  tokenMatches,
  validateAction,
} from '../../lib/cli/ui/request-guard.js';
import { createUiServer, SECURITY_HEADERS } from '../../lib/cli/ui/server.js';
import { createSources } from '../../lib/cli/ui/sources.js';
import run, { DEFAULT_PORT, parseUiArgs, runUi } from '../../lib/cli/ui.js';
import { makeDispatchBoard } from '../helpers/dispatch-board.js';

const TOKEN = 'a'.repeat(64);
const SENTINEL = 'ghp_SENTINEL_never_echo_0123456789';

function request(
  port,
  { method = 'GET', path = '/', headers = {}, body, chunks } = {},
) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method,
        path,
        agent: false,
        headers: { host: `127.0.0.1:${port}`, ...headers },
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => {
          data += c;
        });
        res.on('end', () =>
          resolve({ status: res.statusCode, headers: res.headers, body: data }),
        );
      },
    );
    req.on('error', reject);
    for (const chunk of chunks ?? []) req.write(chunk);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

const api = (port, path, extra = {}) =>
  request(port, {
    path,
    ...extra,
    headers: { 'x-mandrel-token': TOKEN, ...extra.headers },
  });

const post = (port, body, headers = {}) =>
  api(port, '/api/action', {
    method: 'POST',
    body: typeof body === 'string' ? body : JSON.stringify(body),
    headers: {
      origin: `http://127.0.0.1:${port}`,
      'content-type': 'application/json',
      ...headers,
    },
  });

function fakeSources() {
  const calls = { state: 0, connections: 0, actions: [] };
  const result = {
    code: 0,
    envelope: { ok: true, action: 'dispatch', storyId: 7 },
  };
  let stateImpl = async () => ({
    environments: [{ name: 'local', target: 'local', capacity: 1, load: 0 }],
    stories: [{ id: 7, column: 'delivering', stage: 'check' }],
  });
  return {
    calls,
    result,
    setState(fn) {
      stateImpl = fn;
    },
    sources: {
      readState: () => {
        calls.state += 1;
        return stateImpl();
      },
      readConnections: async () => {
        calls.connections += 1;
        return { github: { ok: true, source: 'gh' } };
      },
      runAction: async (action) => {
        calls.actions.push(action);
        return { code: result.code, envelope: result.envelope };
      },
      environmentNames: () => ['local', 'box-2'],
    },
  };
}

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server.address().port;
}

function close(server) {
  server.closeAllConnections?.();
  return new Promise((resolve) => server.close(resolve));
}

function assertSecurityHeaders(res) {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    assert.equal(res.headers[name.toLowerCase()], value, name);
  }
}

describe('ui server', () => {
  let server;
  let port;
  let fake;
  let clock;

  beforeEach(async () => {
    if (server) await close(server);
    fake = fakeSources();
    clock = 1000;
    server = createUiServer({
      token: TOKEN,
      sources: fake.sources,
      now: () => clock,
    });
    port = await listen(server);
  });

  after(async () => {
    await close(server);
  });

  describe('AC-2: forbidden requests reach no state or action', () => {
    it('refuses a foreign Host header', async () => {
      for (const host of [
        'evil.example',
        `127.0.0.1:${port + 1}`,
        `[::1]:${port}`,
      ]) {
        const res = await api(port, '/api/state', { headers: { host } });
        assert.equal(res.status, 403, host);
        assert.deepEqual(JSON.parse(res.body), { error: 'forbidden' });
      }
      const page = await request(port, { headers: { host: 'evil.example' } });
      assert.equal(page.status, 403);
      assert.equal(fake.calls.state, 0);
    });

    it('accepts localhost:<port> as the Host', async () => {
      const res = await api(port, '/api/state', {
        headers: { host: `localhost:${port}` },
      });
      assert.equal(res.status, 200);
    });

    it('refuses a missing or wrong token', async () => {
      const missing = await request(port, { path: '/api/state' });
      const wrong = await request(port, {
        path: '/api/connections',
        headers: { 'x-mandrel-token': 'b'.repeat(64) },
      });
      const short = await request(port, {
        path: '/api/state',
        headers: { 'x-mandrel-token': 'a' },
      });
      for (const res of [missing, wrong, short]) assert.equal(res.status, 403);
      assert.equal(fake.calls.state, 0);
      assert.equal(fake.calls.connections, 0);
    });

    it('refuses a POST with a foreign Origin or a non-JSON content type', async () => {
      const json = 'application/json';
      const own = `http://127.0.0.1:${port}`;
      const cases = [
        { origin: 'http://evil.example', 'content-type': json },
        { 'content-type': json },
        { origin: own, 'content-type': 'text/plain' },
        { origin: own },
      ];
      for (const headers of cases) {
        const res = await api(port, '/api/action', {
          method: 'POST',
          body: JSON.stringify({
            action: 'dispatch',
            storyId: 7,
            environment: 'local',
          }),
          headers,
        });
        assert.equal(res.status, 403, JSON.stringify(headers));
      }
      assert.equal(fake.calls.actions.length, 0);
    });
  });

  describe('AC-3: an invalid body is a 400 and runs nothing', () => {
    const cases = [
      [
        'unknown property',
        { action: 'dispatch', storyId: 7, environment: 'local', force: true },
        'unknown-property',
      ],
      [
        'unknown action',
        { action: 'delete', storyId: 7, environment: 'local' },
        'invalid-action',
      ],
      [
        'string id',
        { action: 'dispatch', storyId: '7', environment: 'local' },
        'invalid-story-id',
      ],
      [
        'fractional id',
        { action: 'dispatch', storyId: 7.5, environment: 'local' },
        'invalid-story-id',
      ],
      [
        'zero id',
        { action: 'dispatch', storyId: 0, environment: 'local' },
        'invalid-story-id',
      ],
      [
        'unconfigured env',
        { action: 'dispatch', storyId: 7, environment: 'other' },
        'invalid-environment',
      ],
      [
        'bad env name',
        { action: 'dispatch', storyId: 7, environment: 'Local!' },
        'invalid-environment',
      ],
      ['missing env', { action: 'stop', storyId: 7 }, 'invalid-environment'],
      ['array body', [1], 'invalid-body'],
      ['null body', null, 'invalid-body'],
    ];
    for (const [name, body, error] of cases) {
      it(`refuses ${name}`, async () => {
        const res = await post(port, body);
        assert.equal(res.status, 400);
        assert.deepEqual(JSON.parse(res.body), { error });
        assert.equal(fake.calls.actions.length, 0);
      });
    }

    it('refuses malformed JSON', async () => {
      const res = await post(port, '{"action":');
      assert.equal(res.status, 400);
      assert.deepEqual(JSON.parse(res.body), { error: 'invalid-json' });
    });

    it('refuses an oversized body by its declared length', async () => {
      const body = JSON.stringify({ pad: 'x'.repeat(5000) });
      const res = await post(port, body, {
        'content-length': String(Buffer.byteLength(body)),
      });
      assert.equal(res.status, 400);
      assert.deepEqual(JSON.parse(res.body), { error: 'body-too-large' });
      assert.equal(fake.calls.actions.length, 0);
    });

    it('refuses an oversized chunked body', async () => {
      const res = await api(port, '/api/action', {
        method: 'POST',
        chunks: ['{"pad":"', 'x'.repeat(3000), 'x'.repeat(3000), '"}'],
        headers: {
          origin: `http://127.0.0.1:${port}`,
          'content-type': 'application/json',
          'transfer-encoding': 'chunked',
        },
      });
      assert.equal(res.status, 400);
      assert.deepEqual(JSON.parse(res.body), { error: 'body-too-large' });
      assert.equal(fake.calls.actions.length, 0);
    });
  });

  describe('AC-4: every response carries the security headers', () => {
    it('on the page, static files, the API and every error', async () => {
      const responses = [
        await request(port, { path: '/' }),
        await request(port, { path: '/board.css' }),
        await request(port, { path: '/board.js' }),
        await request(port, { path: '/board-model.js' }),
        await request(port, { path: '/missing.txt' }),
        await request(port, { path: '/../package.json' }),
        await request(port, { method: 'POST', path: '/' }),
        await request(port, { path: '/api/state' }),
        await api(port, '/api/state'),
        await api(port, '/api/nope'),
        await post(port, { action: 'nope' }),
        await request(port, { headers: { host: 'evil.example' } }),
      ];
      for (const res of responses) assertSecurityHeaders(res);
      assert.deepEqual(
        responses.map((r) => r.status),
        [200, 200, 200, 200, 404, 404, 405, 403, 200, 404, 400, 403],
      );
    });

    it('serves each file with its own type and the token in the page', async () => {
      const page = await request(port);
      assert.match(page.headers['content-type'], /^text\/html/);
      assert.ok(page.body.includes(TOKEN));
      assert.ok(!page.body.includes('__MANDREL_TOKEN__'));
      const css = await request(port, { path: '/board.css' });
      assert.match(css.headers['content-type'], /^text\/css/);
      const js = await request(port, { path: '/board.js' });
      assert.match(js.headers['content-type'], /^text\/javascript/);
    });
  });

  describe('AC-5: state', () => {
    it('returns the read model with its stages', async () => {
      const res = await api(port, '/api/state');
      assert.equal(res.status, 200);
      assert.equal(JSON.parse(res.body).stories[0].stage, 'check');
    });

    it('reuses a read for at most the cache window, and drops it after an action', async () => {
      await api(port, '/api/state');
      clock += 4999;
      await api(port, '/api/state');
      assert.equal(fake.calls.state, 1);
      clock += 1;
      await api(port, '/api/state');
      assert.equal(fake.calls.state, 2);
      await post(port, {
        action: 'dispatch',
        storyId: 7,
        environment: 'local',
      });
      await api(port, '/api/state');
      assert.equal(fake.calls.state, 3);
    });

    it('answers a failed read with an opaque error and does not cache it', async () => {
      fake.setState(async () => {
        throw new Error('/secret/internal/path failed');
      });
      const res = await api(port, '/api/state');
      assert.equal(res.status, 500);
      assert.deepEqual(JSON.parse(res.body), { error: 'internal' });
      fake.setState(async () => ({ environments: [], stories: [] }));
      const again = await api(port, '/api/state');
      assert.equal(again.status, 200);
    });
  });

  describe('AC-6: action', () => {
    it('returns the dispatch envelope on success', async () => {
      const res = await post(port, {
        action: 'dispatch',
        storyId: 7,
        environment: 'box-2',
      });
      assert.equal(res.status, 200);
      assert.deepEqual(JSON.parse(res.body), fake.result.envelope);
      assert.deepEqual(fake.calls.actions, [
        { action: 'dispatch', storyId: 7, environment: 'box-2' },
      ]);
    });

    it('returns a refusal unchanged', async () => {
      fake.result.code = 2;
      fake.result.envelope = {
        ok: false,
        action: 'stop',
        reason: 'closing',
        detail: '#7 is agent::closing; let close land or recover it.',
      };
      const res = await post(port, {
        action: 'stop',
        storyId: 7,
        environment: 'local',
      });
      assert.equal(res.status, 409);
      assert.deepEqual(JSON.parse(res.body), fake.result.envelope);
    });

    it('hides a failed action behind an error code', async () => {
      fake.result.code = 1;
      fake.result.envelope = { ok: false, error: '/home/me/secret stack' };
      const res = await post(port, {
        action: 'resume',
        storyId: 7,
        environment: 'local',
      });
      assert.equal(res.status, 500);
      assert.deepEqual(JSON.parse(res.body), { error: 'action-failed' });
    });

    it('answers a GET on the action route with not-found', async () => {
      const res = await api(port, '/api/action');
      assert.equal(res.status, 404);
      assert.equal(fake.calls.actions.length, 0);
    });
  });

  it('returns the connections report', async () => {
    const res = await api(port, '/api/connections');
    assert.deepEqual(JSON.parse(res.body), {
      github: { ok: true, source: 'gh' },
    });
  });
});

describe('request guard', () => {
  it('allows only loopback hosts on the bound port', () => {
    assert.equal(isAllowedHost('127.0.0.1:4319', 4319), true);
    assert.equal(isAllowedHost('localhost:4319', 4319), true);
    assert.equal(isAllowedHost('localhost', 4319), false);
    assert.equal(isAllowedHost(undefined, 4319), false);
  });

  it('compares the token only at equal length', () => {
    assert.equal(tokenMatches(TOKEN, TOKEN), true);
    assert.equal(tokenMatches(undefined, TOKEN), false);
    assert.equal(tokenMatches(['x'], TOKEN), false);
    assert.equal(tokenMatches(`${TOKEN}0`, TOKEN), false);
  });

  it('accepts JSON with a charset from the same origin', () => {
    assert.equal(
      isSameOriginJson({
        host: 'localhost:1',
        origin: 'http://localhost:1',
        'content-type': 'Application/JSON; charset=utf-8',
      }),
      true,
    );
    assert.equal(isSameOriginJson({}), false);
  });

  it('returns the validated action', () => {
    assert.deepEqual(
      validateAction({ action: 'resume', storyId: 3, environment: 'local' }, [
        'local',
      ]),
      {
        ok: true,
        value: { action: 'resume', storyId: 3, environment: 'local' },
      },
    );
    assert.equal(validateAction('x', ['local']).error, 'invalid-body');
  });
});

/** A sources set over the in-memory dispatch board, running the real `runDispatch`. */
function boardSources(
  tickets,
  { comments = {}, env = {}, runner, overlay = null, config } = {},
) {
  const board = makeDispatchBoard(tickets);
  const resolved = config ?? {
    ...board.deps.config,
    github: { ...board.deps.config.github, owner: 'o', repo: 'r' },
    delivery: {
      environments: {
        local: { target: 'local' },
        box: { target: 'local', command: ['echo', '{id}'] },
      },
    },
  };
  board.deps.provider.getTicketComments = async (id) => {
    if (comments[id] instanceof Error) throw comments[id];
    return comments[id] ?? [];
  };
  const dispatched = [];
  const sources = createSources({
    cwd: 'project-root',
    env,
    runner: runner ?? (async () => ({ status: 1, stdout: '', stderr: '' })),
    readJson: () => overlay,
    resolveConfigImpl: () => resolved,
    createProviderImpl: () => board.deps.provider,
    dispatch: (argv, deps) => {
      dispatched.push({ argv, deps });
      return runDispatch(argv, { ...board.deps, ...deps });
    },
  });
  return { board, sources, dispatched };
}

const stageComment = (storyId, stage) => ({
  body: `Delivery stage: **${stage}**.\n\n\`\`\`json\n${JSON.stringify({ kind: 'delivery-stage', storyId, stage, prNumber: null, updatedAt: 'now' })}\n\`\`\``,
});

describe('sources', () => {
  it('AC-5: joins the published stage onto in-flight Stories only', async () => {
    const { sources, dispatched } = boardSources(
      [
        { id: 7, labels: ['type::story', 'agent::ready'] },
        { id: 9, labels: ['type::story', 'agent::executing', 'env::local'] },
        { id: 10, labels: ['type::story', 'agent::blocked', 'env::box'] },
        { id: 11, labels: ['type::story', 'agent::executing'] },
      ],
      {
        comments: {
          7: [stageComment(7, 'build')],
          9: [
            stageComment(9, 'build'),
            { body: 'chatter' },
            stageComment(9, 'check'),
            { body: null },
          ],
          10: new Error('rate limited'),
        },
      },
    );
    const state = await sources.readState();
    const byId = Object.fromEntries(state.stories.map((s) => [s.id, s]));
    assert.equal(byId[9].stage, 'check');
    assert.equal(byId[10].stage, null);
    assert.equal(byId[11].stage, null);
    assert.equal('stage' in byId[7], false);
    assert.equal(state.repository, 'o/r');
    assert.deepEqual(dispatched[0].argv, ['--status', '--json']);
    assert.equal(dispatched[0].deps.cwd, 'project-root');
  });

  it('throws when the read model cannot be built', async () => {
    const sources = createSources({
      resolveConfigImpl: () => ({}),
      createProviderImpl: () => ({}),
      dispatch: async (_argv, deps) => {
        deps.write('{"ok":false,"error":"boom"}');
        return 1;
      },
    });
    await assert.rejects(sources.readState(), /state-unavailable/);
  });

  it('omits the repository when the config names none', async () => {
    const { sources } = boardSources([], { config: { github: {} } });
    assert.equal((await sources.readState()).repository, null);
  });

  it('AC-6: runs each action through runDispatch and returns its envelope unchanged', async () => {
    const { sources, dispatched, board } = boardSources([
      { id: 7, labels: ['type::story', 'agent::ready'] },
      {
        id: 9,
        labels: ['type::story', 'agent::blocked', 'env::local'],
        assignees: ['me'],
      },
      {
        id: 12,
        labels: ['type::story', 'agent::closing', 'env::local'],
        assignees: ['me'],
      },
    ]);
    const dispatchRun = await sources.runAction({
      action: 'dispatch',
      storyId: 7,
      environment: 'box',
    });
    assert.equal(dispatchRun.code, 0);
    assert.equal(dispatchRun.envelope.ok, true);
    assert.equal(dispatchRun.envelope.environment, 'box');
    assert.deepEqual(
      board.launches.map((l) => l.storyId),
      [7],
    );

    const resume = await sources.runAction({
      action: 'resume',
      storyId: 9,
      environment: 'local',
    });
    assert.equal(resume.envelope.action, 'resume');

    const refused = await sources.runAction({
      action: 'stop',
      storyId: 12,
      environment: 'local',
    });
    assert.equal(refused.code, 2);
    assert.equal(refused.envelope.reason, 'closing');

    assert.deepEqual(
      dispatched.map((d) => d.argv),
      [
        ['--env', 'box', '7'],
        ['--resume', '--env', 'local', '9'],
        ['--stop', '--env', 'local', '12'],
      ],
    );
  });

  it('lists the configured environment names', () => {
    const { sources } = boardSources([]);
    assert.deepEqual(sources.environmentNames(), ['local', 'box']);
  });

  describe('AC-7: connections report presence and source only', () => {
    const claudeOk = async (cmd) =>
      cmd === 'claude'
        ? { status: 0, stdout: '2.1.300', stderr: '' }
        : { status: 0, stdout: `${SENTINEL}\n`, stderr: '' };

    it('names the environment variable as the source, never the value', async () => {
      const { sources } = boardSources([], {
        env: { GITHUB_TOKEN: SENTINEL },
        runner: claudeOk,
        overlay: { delivery: { environments: { box: { target: 'local' } } } },
      });
      const report = await sources.readConnections();
      assert.deepEqual(report.github, { ok: true, source: 'environment' });
      assert.deepEqual(report.claude, { ok: true });
      assert.deepEqual(report.environments, [
        {
          name: 'local',
          target: 'local',
          online: true,
          reason: null,
          definedIn: '.agentrc.json',
        },
        {
          name: 'box',
          target: 'local',
          online: true,
          reason: null,
          definedIn: '.agentrc.local.json',
        },
      ]);
      assert.ok(!JSON.stringify(report).includes(SENTINEL));
    });

    it('names gh as the source when only `gh auth token` resolves', async () => {
      const { sources } = boardSources([], { runner: claudeOk });
      const report = await sources.readConnections();
      assert.deepEqual(report.github, { ok: true, source: 'gh' });
      assert.ok(!JSON.stringify(report).includes(SENTINEL));
    });

    it('takes environments offline and says why', async () => {
      const noClaude = boardSources([], {
        env: { GH_TOKEN: SENTINEL },
        runner: async () => ({
          status: null,
          stdout: '',
          stderr: '',
          error: Object.assign(new Error('x'), { code: 'ENOENT' }),
        }),
      });
      const report = await noClaude.sources.readConnections();
      assert.deepEqual(report.claude, { ok: false });
      assert.deepEqual(
        report.environments.map((e) => [e.name, e.online, e.reason]),
        [
          ['local', false, 'claude CLI not found'],
          ['box', true, null],
        ],
      );
      const noToken = boardSources([], { config: { github: {} } });
      const bare = await noToken.sources.readConnections();
      assert.deepEqual(bare.github, { ok: false, source: null });
      assert.deepEqual(bare.environments, [
        {
          name: 'local',
          target: 'local',
          online: false,
          reason: 'no GitHub token',
          definedIn: 'default',
        },
      ]);
    });

    it('keeps the sentinel out of every server response', async () => {
      const { sources } = boardSources(
        [{ id: 9, labels: ['type::story', 'agent::executing', 'env::local'] }],
        { env: { GITHUB_TOKEN: SENTINEL }, runner: claudeOk },
      );
      const server = createUiServer({ token: TOKEN, sources });
      const port = await listen(server);
      try {
        const bodies = [
          (await api(port, '/api/connections')).body,
          (await api(port, '/api/state')).body,
          (await request(port)).body,
          (
            await post(port, {
              action: 'stop',
              storyId: 9,
              environment: 'local',
            })
          ).body,
        ];
        for (const body of bodies) assert.ok(!body.includes(SENTINEL));
      } finally {
        await close(server);
      }
    });
  });
});

describe('mandrel ui entry', () => {
  let out;
  let errs;
  let codes;
  const deps = (extra = {}) => ({
    write: (s) => out.push(s),
    errOut: (s) => errs.push(s),
    exit: (c) => codes.push(c),
    token: TOKEN,
    sources: fakeSources().sources,
    ...extra,
  });

  beforeEach(() => {
    out = [];
    errs = [];
    codes = [];
  });

  it('AC-1: binds 127.0.0.1 on the given port and prints its URL', async () => {
    const server = await runUi(['--port', '0'], deps());
    try {
      const address = server.address();
      assert.equal(address.address, '127.0.0.1');
      assert.deepEqual(out, [
        `mandrel ui: http://127.0.0.1:${address.port}/\n`,
      ]);
    } finally {
      await close(server);
    }
  });

  it('builds the real sources when none are injected, without reading them', async () => {
    const server = await runUi(
      ['--port=0'],
      deps({ sources: undefined, token: undefined }),
    );
    await close(server);
    assert.equal(codes.length, 0);
  });

  it('reports a port it cannot listen on', async () => {
    const holder = http.createServer();
    const port = await listen(holder);
    try {
      const server = await runUi(['--port', String(port)], deps());
      assert.equal(server, null);
      assert.deepEqual(codes, [1]);
      assert.match(errs.join(''), /cannot listen on port \d+: EADDRINUSE/);
    } finally {
      await close(holder);
    }
  });

  it('prints usage for --help and rejects bad arguments', async () => {
    await run(['--help'], deps());
    assert.match(out.join(''), /Usage: mandrel ui \[--port <n>\]/);
    assert.equal(await runUi(['--port', 'x'], deps()), null);
    assert.equal(await runUi(['extra'], deps()), null);
    assert.deepEqual(codes, [1, 1]);
    assert.match(errs.join(''), /--port needs an integer/);
  });

  it('parses the port, defaulting to 4319', () => {
    assert.deepEqual(parseUiArgs([]), { port: DEFAULT_PORT, help: false });
    assert.equal(DEFAULT_PORT, 4319);
    assert.deepEqual(parseUiArgs(['-h']), { port: 4319, help: true });
    assert.throws(() => parseUiArgs(['--port', '70000']), /--port/);
    assert.throws(() => parseUiArgs(['--port']), /--port/);
  });
});
