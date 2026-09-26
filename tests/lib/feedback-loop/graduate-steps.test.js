import { strict as assert } from 'node:assert';
import { EventEmitter } from 'node:events';
import { describe, it } from 'node:test';

import {
  dedupFinding,
  fileFinding,
  probeFindingPath,
  recordRecurrence,
  routeFinding,
} from '../../../.agents/scripts/lib/feedback-loop/graduate-steps.js';

const CONSUMER = { owner: 'o', repo: 'r' };

function stubSpawn(respond) {
  const calls = [];
  const spawnImpl = (cmd, args) => {
    calls.push({ cmd, args });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    const { stdout = '', stderr = '', code = 0 } = respond(cmd, args) ?? {};
    queueMicrotask(() => {
      if (stdout) child.stdout.emit('data', Buffer.from(stdout));
      if (stderr) child.stderr.emit('data', Buffer.from(stderr));
      child.emit('close', code);
    });
    return child;
  };
  return { gh: { ghPath: 'gh', spawnImpl, timeoutMs: 0 }, calls };
}

function makeWalk(overrides = {}) {
  const envelope = { filed: [], skipped: [], errors: [] };
  const skips = [];
  return {
    finding: { index: 0, path: 'a.js', severity: 'high' },
    epicId: 7,
    routedRepo: CONSUMER,
    source: 'consumer',
    contentMarker: 'mk-1',
    envelope,
    decorate: (record) => record,
    skip: (reason) => skips.push(reason),
    skips,
    filedMarkers: new Set(),
    labelCache: new Map(),
    maxFilingsPerRun: 5,
    spec: {},
    ...overrides,
  };
}

describe('probeFindingPath', () => {
  it('skips the probe for a path-less finding', async () => {
    const { gh, calls } = stubSpawn(() => ({}));
    const reason = await probeFindingPath({
      finding: { path: '  ' },
      gitRef: 'HEAD',
      gh,
    });
    assert.equal(reason, null);
    assert.equal(calls.length, 0);
  });

  it('maps a missing file and a failed probe to their skip reasons', async () => {
    const missing = stubSpawn(() => ({ code: 1 }));
    assert.equal(
      await probeFindingPath({
        finding: { path: 'a.js' },
        gitRef: 'HEAD',
        gh: missing.gh,
      }),
      'file-removed',
    );
    assert.deepEqual(missing.calls[0].args, ['cat-file', '-e', 'HEAD:a.js']);
    const broken = {
      spawnImpl: () => {
        throw new Error('no git');
      },
    };
    assert.equal(
      await probeFindingPath({
        finding: { path: 'a.js' },
        gitRef: 'HEAD',
        gh: broken,
      }),
      'probe-error',
    );
  });
});

describe('routeFinding', () => {
  const spec = {
    fnName: 'g',
    buildCrossRepoLog: ({ routedRepo }) => `cross ${routedRepo.repo}`,
  };

  it('routes a consumer finding to the current repo', () => {
    const route = routeFinding({
      finding: { index: 0, path: 'a.js' },
      classifier: () => 'consumer',
      repos: { consumer: CONSUMER },
      currentRepo: CONSUMER,
      spec,
    });
    assert.deepEqual(route, {
      source: 'consumer',
      routedRepo: CONSUMER,
      deferred: null,
      skipReason: null,
    });
  });

  it('defers an unroutable finding with the missing key named', () => {
    const warnings = [];
    const route = routeFinding({
      finding: { index: 3, path: 'a.js' },
      classifier: () => 'framework',
      repos: { consumer: CONSUMER, framework: null },
      currentRepo: CONSUMER,
      logger: { warn: (line) => warnings.push(line) },
      spec,
    });
    assert.equal(route.skipReason, 'unroutable');
    assert.equal(route.deferred.routedRepo, null);
    assert.ok(route.deferred.missingKey);
    assert.deepEqual(warnings, [route.deferred.logLine]);
  });

  it('defers a cross-repo finding with the spec log line', () => {
    const route = routeFinding({
      finding: { index: 0, path: 'a.js' },
      classifier: () => 'framework',
      repos: { consumer: CONSUMER, framework: { owner: 'f', repo: 'fw' } },
      currentRepo: CONSUMER,
      spec,
    });
    assert.equal(route.skipReason, 'cross-repo-deferred');
    assert.equal(route.deferred.logLine, 'cross fw');
  });
});

describe('dedupFinding', () => {
  it('falls back to the legacy marker when the content marker misses', async () => {
    const { gh, calls } = stubSpawn((_cmd, args) =>
      args[2] === 'legacy-1'
        ? { stdout: '[{"number":9,"state":"OPEN","url":"u"}]' }
        : { stdout: '[]' },
    );
    const existing = await dedupFinding(
      makeWalk({ gh, spec: { buildLegacyMarker: () => 'legacy-1' } }),
    );
    assert.deepEqual(existing, { number: 9, state: 'open', url: 'u' });
    assert.equal(calls.length, 2);
  });

  it('returns null without a legacy builder when nothing matches', async () => {
    const { gh, calls } = stubSpawn(() => ({ stdout: '[]' }));
    assert.equal(await dedupFinding(makeWalk({ gh })), null);
    assert.equal(calls.length, 1);
  });
});

describe('recordRecurrence', () => {
  it('leaves a closed match untouched as already-filed', async () => {
    const { gh, calls } = stubSpawn(() => ({}));
    const walk = makeWalk({ gh });
    await recordRecurrence(walk, { number: 4, state: 'closed', url: '' }, 'b');
    assert.deepEqual(walk.skips, ['already-filed']);
    assert.equal(calls.length, 0);
    assert.ok(walk.filedMarkers.has('mk-1'));
  });

  it('refreshes an open match and records it as updated', async () => {
    const { gh } = stubSpawn(() => ({ stdout: 'https://x/4\n' }));
    const walk = makeWalk({ gh });
    await recordRecurrence(walk, { number: 4, state: 'open', url: '' }, 'b');
    assert.equal(walk.envelope.filed[0].action, 'updated');
    assert.equal(walk.envelope.filed[0].url, 'https://x/4');
  });
});

describe('fileFinding', () => {
  const followUp = { title: 't', body: 'b', labels: ['meta::x'] };
  const labelList = '[{"name":"meta::x"}]';

  it('skips once the per-run cap is reached', async () => {
    const { gh, calls } = stubSpawn(() => ({}));
    const walk = makeWalk({ gh, maxFilingsPerRun: 0 });
    await fileFinding(walk, followUp);
    assert.deepEqual(walk.skips, ['cap-reached']);
    assert.equal(calls.length, 0);
  });

  it('skips when a label cannot be minted', async () => {
    const { gh } = stubSpawn((_cmd, args) =>
      args[1] === 'list' ? { stdout: '[]' } : { code: 1, stderr: 'denied' },
    );
    const walk = makeWalk({ gh });
    await fileFinding(walk, followUp);
    assert.deepEqual(walk.skips, ['label-ensure-failed']);
    assert.equal(walk.envelope.errors.length, 1);
  });

  it('treats a strong-read match as a recurrence', async () => {
    const { gh } = stubSpawn((_cmd, args) => {
      if (args[0] === 'label') return { stdout: labelList };
      if (args[1] === 'list') {
        return { stdout: '[{"number":2,"state":"closed","body":"mk-1"}]' };
      }
      return {};
    });
    const walk = makeWalk({ gh });
    await fileFinding(walk, followUp);
    assert.deepEqual(walk.skips, ['already-filed']);
  });

  it('creates the issue and records it as created', async () => {
    const { gh } = stubSpawn((_cmd, args) => {
      if (args[0] === 'label') return { stdout: labelList };
      if (args[1] === 'list') return { stdout: '[]' };
      return { stdout: 'https://x/5\n' };
    });
    const walk = makeWalk({ gh });
    await fileFinding(walk, followUp);
    assert.equal(walk.envelope.filed[0].action, 'created');
    assert.equal(walk.envelope.filed[0].url, 'https://x/5');
    assert.ok(walk.filedMarkers.has('mk-1'));
  });

  it('reports a failed create without recording a filing', async () => {
    const { gh } = stubSpawn((_cmd, args) => {
      if (args[0] === 'label') return { stdout: labelList };
      if (args[1] === 'list') return { stdout: '[]' };
      return { code: 1, stderr: 'boom' };
    });
    const walk = makeWalk({ gh });
    await fileFinding(walk, followUp);
    assert.equal(walk.envelope.filed.length, 0);
    assert.match(walk.envelope.errors[0], /gh issue create exited 1: boom/);
  });
});
