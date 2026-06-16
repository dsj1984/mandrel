/**
 * Contract tests for the benchmark scenario corpus and its frozen quality
 * oracles (Story #4214).
 *
 * Verifies the three acceptance criteria of the Story:
 *   1. Each scenario seed (`bench/scenarios/<id>/scenario.json`) defines the
 *      task seed used by both arms (a prompt + the acceptance contract).
 *   2. Each frozen oracle (`acceptance.test.js#evaluate`) asserts the
 *      delivered app's user-visible HTTP behavior and is frozen — pure with
 *      respect to the app (no app-internal imports), deterministic, and
 *      structured (one verdict per criterion, in seed order).
 *   3. The adapter (`acceptance-eval-adapter.js`) invokes the existing
 *      acceptance-eval cross-check and returns its verdict alongside the
 *      frozen-suite result.
 *
 * These are contract-tier checks: they assert the shape of the scenario
 * assets and the wiring to the cross-check, with the HTTP boundary and the
 * cross-check gate both injected (no real `claude`, no network, no server).
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  buildVerdictFromFrozenResult,
  parseGateEnvelope,
  runCrossCheckViaCli,
  scoreScenarioQuality,
} from '../../../bench/scenarios/acceptance-eval-adapter.js';
import { evaluate as evaluateCrud } from '../../../bench/scenarios/crud-db/acceptance.test.js';
import { evaluate as evaluateHello } from '../../../bench/scenarios/hello-world/acceptance.test.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIOS_DIR = path.resolve(
  __dirname,
  '..',
  '..',
  '..',
  'bench',
  'scenarios',
);
const SCENARIO_IDS = ['hello-world', 'crud-db'];

function loadScenario(id) {
  const raw = readFileSync(
    path.join(SCENARIOS_DIR, id, 'scenario.json'),
    'utf8',
  );
  return JSON.parse(raw);
}

/**
 * Build a stub `fetch` from an ordered list of canned responses keyed by a
 * matcher predicate, so a frozen oracle can be driven without a server.
 *
 * @param {Array<{ when: (url: string, init: object) => boolean, status: number, headers?: Record<string,string>, json?: unknown, text?: string }>} routes
 */
function stubFetch(routes) {
  return async (url, init = {}) => {
    const route = routes.find((r) => r.when(String(url), init));
    if (!route) {
      throw new Error(`stubFetch: no route for ${init.method ?? 'GET'} ${url}`);
    }
    const headers = new Map(
      Object.entries(route.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
    );
    return {
      status: route.status,
      headers: { get: (k) => headers.get(String(k).toLowerCase()) ?? null },
      async text() {
        return (
          route.text ??
          (route.json !== undefined ? JSON.stringify(route.json) : '')
        );
      },
      async json() {
        if (route.json === undefined) throw new Error('no json');
        return route.json;
      },
    };
  };
}

describe('scenario seeds (AC1: task seed shared by both arms)', () => {
  it('exposes exactly the two v1 scenarios on disk', () => {
    const dirs = readdirSync(SCENARIOS_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
    assert.deepEqual(dirs, [...SCENARIO_IDS].sort());
  });

  for (const id of SCENARIO_IDS) {
    it(`${id}/scenario.json defines a non-empty task seed and acceptance contract`, () => {
      const s = loadScenario(id);
      assert.equal(s.id, id, 'id matches its directory');
      assert.equal(typeof s.title, 'string');
      assert.ok(s.title.length > 0, 'has a title');

      // The seed is the task both arms receive — a prompt plus the
      // acceptance contract. It must be present and non-trivial.
      assert.ok(s.seed && typeof s.seed === 'object', 'has a seed object');
      assert.equal(typeof s.seed.prompt, 'string');
      assert.ok(
        s.seed.prompt.length >= 40,
        'seed prompt is a real task description',
      );
      assert.ok(
        Array.isArray(s.seed.acceptance) && s.seed.acceptance.length > 0,
        'seed carries the acceptance contract',
      );
      for (const item of s.seed.acceptance) {
        assert.equal(typeof item, 'string');
        assert.ok(item.length > 0);
      }

      // The seed must point at its frozen acceptance suite, and the app
      // launch contract must be present so the harness can boot it.
      assert.equal(s.acceptanceSuite, './acceptance.test.js');
      assert.ok(
        s.app && typeof s.app === 'object',
        'declares an app launch contract',
      );
      assert.equal(typeof s.app.startCommand, 'string');
      assert.equal(typeof s.app.portEnvVar, 'string');
      assert.equal(typeof s.app.readinessPath, 'string');
    });
  }

  it('difficulty is monotonic across the ladder (hello-world < crud-db)', () => {
    const hello = loadScenario('hello-world');
    const crud = loadScenario('crud-db');
    assert.ok(
      Number(hello.difficulty) < Number(crud.difficulty),
      'crud-db must out-rank hello-world on difficulty for the monotonicity check',
    );
  });
});

describe('frozen oracles are pure w.r.t. the delivered app (AC2: frozen)', () => {
  for (const id of SCENARIO_IDS) {
    it(`${id}/acceptance.test.js imports nothing from the delivered app`, () => {
      const src = readFileSync(
        path.join(SCENARIOS_DIR, id, 'acceptance.test.js'),
        'utf8',
      );
      const importRe = /^\s*import\s[^;]*from\s+['"]([^'"]+)['"]/gm;
      const specs = [...src.matchAll(importRe)].map((m) => m[1]);
      for (const spec of specs) {
        // A frozen oracle may import node builtins only. Any relative or
        // bare third-party import would couple it to app or framework
        // internals and break the freeze.
        assert.ok(
          spec.startsWith('node:'),
          `frozen oracle ${id} must import only node: builtins, found "${spec}"`,
        );
      }
    });

    it(`${id}/acceptance.test.js exports a frozen criteria list and an evaluate()`, async () => {
      const mod = await import(
        `../../../bench/scenarios/${id}/acceptance.test.js`
      );
      assert.equal(typeof mod.evaluate, 'function');
      assert.ok(Array.isArray(mod.CRITERIA) && mod.CRITERIA.length > 0);
      assert.ok(Object.isFrozen(mod.CRITERIA), 'CRITERIA is frozen');

      // The oracle's criteria text matches the scenario seed exactly, so
      // the verdict the adapter builds lines up criterion for criterion.
      const seed = loadScenario(id);
      assert.deepEqual([...mod.CRITERIA], seed.seed.acceptance);
    });
  }

  it('rejects a non-string baseUrl', async () => {
    await assert.rejects(() => evaluateHello(''), TypeError);
    await assert.rejects(() => evaluateCrud(undefined), TypeError);
  });
});

describe('hello-world frozen oracle behavior', () => {
  it('passes when the delivered page returns 200 text/html with the text', async () => {
    const fetchImpl = stubFetch([
      {
        when: (u) => u.endsWith('/'),
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
        text: '<!doctype html><h1>Hello, World!</h1>',
      },
    ]);
    const result = await evaluateHello('http://127.0.0.1:3000', { fetchImpl });
    assert.equal(result.scenario, 'hello-world');
    assert.equal(result.passed, true);
    assert.equal(result.criteria.length, 3);
    assert.ok(result.criteria.every((c) => c.met));
    // Criteria are returned in seed order.
    assert.deepEqual(
      result.criteria.map((c) => c.index),
      [0, 1, 2],
    );
  });

  it('fails each criterion when the body lacks the text / wrong type / wrong status', async () => {
    const fetchImpl = stubFetch([
      {
        when: (u) => u.endsWith('/'),
        status: 500,
        headers: { 'content-type': 'application/json' },
        text: 'nope',
      },
    ]);
    const result = await evaluateHello('http://127.0.0.1:3000', { fetchImpl });
    assert.equal(result.passed, false);
    assert.deepEqual(
      result.criteria.map((c) => c.met),
      [false, false, false],
    );
  });

  it('does not throw when the app is unreachable; reports a transport failure', async () => {
    const fetchImpl = async () => {
      throw new Error('ECONNREFUSED');
    };
    const result = await evaluateHello('http://127.0.0.1:3000', { fetchImpl });
    assert.equal(result.passed, false);
    assert.ok(result.criteria[0].evidence.includes('ECONNREFUSED'));
  });

  it('is deterministic — identical inputs yield identical output', async () => {
    const make = () =>
      stubFetch([
        {
          when: (u) => u.endsWith('/'),
          status: 200,
          headers: { 'content-type': 'text/html' },
          text: 'Hello, World!',
        },
      ]);
    const a = await evaluateHello('http://h', { fetchImpl: make() });
    const b = await evaluateHello('http://h', { fetchImpl: make() });
    assert.deepEqual(a, b);
  });
});

describe('crud-db frozen oracle behavior', () => {
  // A dynamic fetch stub modelling a conforming in-memory notes backend,
  // so the full stateful CRUD round-trip can be driven deterministically
  // without a real server.
  function makeCrudFetch() {
    const store = new Map();
    let seq = 0;
    const send = (status, json) => ({
      status,
      headers: { get: () => 'application/json' },
      async text() {
        return json === undefined ? '' : JSON.stringify(json);
      },
      async json() {
        if (json === undefined) throw new Error('no json');
        return json;
      },
    });
    return async (url, init = {}) => {
      const u = new URL(String(url));
      const parts = u.pathname.split('/').filter(Boolean); // ['notes'] or ['notes', ':id']
      const method = init.method ?? 'GET';
      const body = init.body ? JSON.parse(init.body) : undefined;

      if (parts[0] !== 'notes') return send(404);

      // Collection
      if (parts.length === 1) {
        if (method === 'POST') {
          const okTitle =
            typeof body?.title === 'string' && body.title.length > 0;
          const okBody = typeof body?.body === 'string' && body.body.length > 0;
          if (!okTitle || !okBody) return send(400, { error: 'invalid' });
          const id = `id-${++seq}`;
          const note = {
            id,
            title: body.title,
            body: body.body,
            createdAt: '2026-01-01T00:00:00Z',
          };
          store.set(id, note);
          return send(201, note);
        }
        if (method === 'GET') return send(200, [...store.values()]);
        return send(405);
      }

      // Item
      const id = decodeURIComponent(parts[1]);
      const existing = store.get(id);
      if (method === 'GET')
        return existing
          ? send(200, existing)
          : send(404, { error: 'not found' });
      if (method === 'PUT') {
        if (!existing) return send(404, { error: 'not found' });
        const updated = { ...existing, ...(body ?? {}) };
        store.set(id, updated);
        return send(200, updated);
      }
      if (method === 'DELETE') {
        if (!existing) return send(404);
        store.delete(id);
        return send(204);
      }
      return send(405);
    };
  }

  it('passes the full CRUD round-trip against a conforming backend', async () => {
    const result = await evaluateCrud('http://127.0.0.1:3000', {
      fetchImpl: makeCrudFetch(),
      uniqueSuffix: () => 'fixed',
    });
    assert.equal(result.scenario, 'crud-db');
    assert.equal(
      result.passed,
      true,
      `unmet: ${result.criteria
        .filter((c) => !c.met)
        .map((c) => c.evidence)
        .join('; ')}`,
    );
    assert.equal(result.criteria.length, 6);
    assert.deepEqual(
      result.criteria.map((c) => c.index),
      [0, 1, 2, 3, 4, 5],
    );
  });

  it('flags the invalid-payload criterion when the backend accepts junk', async () => {
    // A backend that returns 201 for an empty body fails criterion 5.
    const base = makeCrudFetch();
    const fetchImpl = async (url, init = {}) => {
      const u = new URL(String(url));
      const body = init.body ? JSON.parse(init.body) : undefined;
      if (
        u.pathname === '/notes' &&
        init.method === 'POST' &&
        (!body?.title || !body?.body)
      ) {
        // Wrongly accept invalid input.
        return {
          status: 201,
          headers: { get: () => 'application/json' },
          async text() {
            return JSON.stringify({ id: 'x' });
          },
          async json() {
            return { id: 'x' };
          },
        };
      }
      return base(url, init);
    };
    const result = await evaluateCrud('http://127.0.0.1:3000', {
      fetchImpl,
      uniqueSuffix: () => 'fixed',
    });
    const c5 = result.criteria.find((c) => c.index === 5);
    assert.equal(c5.met, false);
    assert.equal(result.passed, false);
  });

  it('does not throw when the backend is unreachable', async () => {
    const result = await evaluateCrud('http://127.0.0.1:3000', {
      fetchImpl: async () => {
        throw new Error('ECONNREFUSED');
      },
    });
    assert.equal(result.passed, false);
    assert.equal(result.criteria.length, 6);
    assert.ok(result.criteria[0].evidence.includes('ECONNREFUSED'));
  });
});

describe('acceptance-eval cross-check adapter (AC3)', () => {
  const frozenPass = {
    scenario: 'hello-world',
    passed: true,
    criteria: [
      { index: 0, criterion: 'a', met: true, evidence: 'ok-a' },
      { index: 1, criterion: 'b', met: true, evidence: 'ok-b' },
    ],
  };
  const frozenFail = {
    scenario: 'hello-world',
    passed: false,
    criteria: [
      { index: 0, criterion: 'a', met: true, evidence: 'ok-a' },
      { index: 1, criterion: 'b', met: false, evidence: 'bad-b' },
    ],
  };

  it('lifts a frozen result into a schema-valid acceptance-eval verdict', () => {
    const verdict = buildVerdictFromFrozenResult({
      frozenResult: frozenFail,
      storyId: 4214,
      epicId: 4211,
    });
    assert.equal(verdict.storyId, 4214);
    assert.equal(verdict.epicId, 4211);
    assert.equal(verdict.schemaVersion, 1);
    assert.equal(verdict.round, 1);
    assert.equal(verdict.criteria.length, 2);
    assert.equal(verdict.criteria[0].verdict, 'met');
    assert.equal(verdict.criteria[1].verdict, 'unmet');
    assert.equal(verdict.criteria[1].evidence, 'bad-b');
    // verify[]-as-evidence is carried so the cross-check sees the probe.
    assert.equal(verdict.criteria[0].verifyEvidence[0].outcome, 'pass');
    assert.equal(verdict.criteria[1].verifyEvidence[0].outcome, 'fail');
  });

  it('the lifted verdict actually validates against the real verdict schema', async () => {
    // Use the same gate validator the production cross-check uses, so this
    // is a genuine contract assertion, not a re-implementation.
    const { validateVerdict } = await import(
      '../../../.agents/scripts/acceptance-eval.js'
    );
    const verdict = buildVerdictFromFrozenResult({
      frozenResult: frozenPass,
      storyId: 4214,
      epicId: 4211,
    });
    assert.doesNotThrow(() => validateVerdict(verdict));
  });

  it('invokes the existing cross-check in-process and returns its verdict alongside the frozen result', async () => {
    // Inject the gate so we assert the wiring (the verdict reaches the
    // gate; the gate decision reaches the caller) without exercising the
    // gate's own decision logic here.
    let received = null;
    const runGateFn = async (args) => {
      received = args;
      return {
        envelope: { decision: 'proceed', metCount: 2, totalCriteria: 2 },
        exitCode: 0,
      };
    };
    const out = await scoreScenarioQuality({
      evaluate: async () => frozenPass,
      baseUrl: 'http://127.0.0.1:3000',
      storyId: 4214,
      epicId: 4211,
      transport: 'in-process',
      runGateFn,
    });
    // The cross-check received the lifted verdict.
    assert.ok(received, 'gate was invoked');
    assert.equal(received.verdict.storyId, 4214);
    assert.equal(
      received.emitSignal,
      false,
      'benchmark probe suppresses the signal emit',
    );
    // The combined result carries BOTH faces of the Quality score.
    assert.equal(out.scenario, 'hello-world');
    assert.equal(out.frozen.passed, true);
    assert.equal(out.crossCheck.decision, 'proceed');
    assert.equal(out.agree, true);
  });

  it('reports disagreement when the frozen suite fails but the cross-check would proceed', async () => {
    const runGateFn = async () => ({
      envelope: { decision: 'proceed' },
      exitCode: 0,
    });
    const out = await scoreScenarioQuality({
      evaluate: async () => frozenFail,
      baseUrl: 'http://127.0.0.1:3000',
      storyId: 4214,
      epicId: 4211,
      transport: 'in-process',
      runGateFn,
    });
    assert.equal(out.frozen.passed, false);
    assert.equal(out.crossCheck.decision, 'proceed');
    assert.equal(out.agree, false);
  });

  it('CLI transport spawns acceptance-eval.js with --no-signal and parses its envelope', () => {
    let spawnArgs = null;
    const spawnFn = (exe, args) => {
      spawnArgs = { exe, args };
      return {
        status: 0,
        stdout:
          'some log line\n' +
          JSON.stringify(
            { storyId: 4214, decision: 'proceed', metCount: 2 },
            null,
            2,
          ),
      };
    };
    const verdict = buildVerdictFromFrozenResult({
      frozenResult: frozenPass,
      storyId: 4214,
      epicId: 4211,
    });
    const out = runCrossCheckViaCli({
      verdict,
      storyId: 4214,
      epicId: 4211,
      spawnFn,
    });
    assert.ok(
      spawnArgs.args.includes('--no-signal'),
      'CLI probe is side-effect free',
    );
    assert.ok(spawnArgs.args.includes('--story'));
    assert.ok(spawnArgs.args.includes('4214'));
    assert.ok(spawnArgs.args.includes('--epic'));
    assert.equal(out.decision, 'proceed');
    assert.equal(out.exitCode, 0);
  });
});

describe('parseGateEnvelope', () => {
  it('extracts the trailing JSON envelope from mixed stdout', () => {
    const stdout =
      '[Orchestrator] noise\n' +
      JSON.stringify({ decision: 'block', a: 1 }, null, 2);
    assert.deepEqual(parseGateEnvelope(stdout), { decision: 'block', a: 1 });
  });

  it('returns null for empty / unparseable stdout', () => {
    assert.equal(parseGateEnvelope(''), null);
    assert.equal(parseGateEnvelope('not json at all'), null);
  });
});
