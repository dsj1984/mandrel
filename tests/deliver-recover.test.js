import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  parseArgv,
  runDeliverRecover,
} from '../.agents/scripts/deliver-recover.js';

/**
 * Story #4780 — `runDeliverRecover` scored CRAP 85.4: the read-only probe an
 * operator reaches for when a Story is stranded had no test file, so its
 * argument contract (the one that decides whether it prints a command or
 * refuses) was unverified.
 *
 * Config resolution, provider construction, the probe, the renderer, and the
 * log sink are all injected through the optional final `deps` parameter
 * (`docs/contributing/test-seams.md` rules 1 and 5): no GitHub call, no git
 * spawn, no module mocking.
 */

function harness(
  recovery = { shape: 'merged-label-stale', nextCommand: 'gh x' },
) {
  const infos = [];
  const probes = [];
  return {
    infos,
    probes,
    recovery,
    deps: {
      resolveConfigImpl: (args) => ({ resolvedFor: args?.cwd }),
      createProviderImpl: (config) => ({ providerFor: config.resolvedFor }),
      recoverStoryImpl: async (args) => {
        probes.push(args);
        return recovery;
      },
      renderRecoveryImpl: (r) => `PROSE:${r.shape}`,
      logger: { info: (m) => infos.push(m) },
    },
  };
}

describe('deliver-recover parseArgv', () => {
  it('parses a full argv', () => {
    assert.deepEqual(
      parseArgv([
        '--story',
        '4780',
        '--cwd',
        '/repo',
        '--json',
        '--no-reprobe',
      ]),
      { storyId: 4780, cwd: '/repo', json: true, reprobe: false, help: false },
    );
  });

  it('defaults cwd to null, json to false, and reprobe to true', () => {
    assert.deepEqual(parseArgv(['--story', '12']), {
      storyId: 12,
      cwd: null,
      json: false,
      reprobe: true,
      help: false,
    });
  });

  it('yields NaN for a missing or non-numeric --story', () => {
    assert.ok(Number.isNaN(parseArgv([]).storyId));
    assert.ok(Number.isNaN(parseArgv(['--story', 'abc']).storyId));
  });

  it('records --help', () => {
    assert.equal(parseArgv(['--help']).help, true);
  });
});

describe('runDeliverRecover', () => {
  it('prints the help text and probes nothing under --help', async () => {
    const h = harness();
    const result = await runDeliverRecover({ argv: ['--help'] }, h.deps);
    assert.deepEqual(result, { success: true, result: null });
    assert.equal(h.probes.length, 0);
    assert.match(
      h.infos[0],
      /Usage: node \.agents\/scripts\/deliver-recover\.js/,
    );
    assert.match(h.infos[0], /Read-only: mutates nothing/);
  });

  it('refuses a missing, non-numeric, zero, or negative story id', async () => {
    for (const argv of [
      [],
      ['--story', 'abc'],
      ['--story', '0'],
      ['--story', '-3'],
    ]) {
      const h = harness();
      await assert.rejects(
        () => runDeliverRecover({ argv }, h.deps),
        /Usage: node deliver-recover\.js --story <STORY_ID>/,
      );
      assert.equal(h.probes.length, 0);
    }
  });

  it('probes the parsed story and renders prose by default', async () => {
    const h = harness();
    const result = await runDeliverRecover(
      { argv: ['--story', '4780', '--cwd', '/repo'] },
      h.deps,
    );
    assert.equal(result.success, true);
    assert.equal(h.probes[0].storyId, 4780);
    assert.equal(h.probes[0].cwd, '/repo');
    assert.equal(h.probes[0].reprobe, true);
    assert.equal(h.infos[0], 'PROSE:merged-label-stale');
  });

  it('emits the full envelope as JSON under --json', async () => {
    const h = harness();
    await runDeliverRecover({ argv: ['--story', '1', '--json'] }, h.deps);
    assert.deepEqual(JSON.parse(h.infos[0]), h.recovery);
  });

  it('takes the direct-argument path over argv when storyId is supplied', async () => {
    const h = harness();
    await runDeliverRecover(
      {
        storyId: 99,
        cwd: '/other',
        json: true,
        reprobe: false,
        argv: ['--story', '1'],
      },
      h.deps,
    );
    assert.equal(h.probes[0].storyId, 99);
    assert.equal(h.probes[0].cwd, '/other');
    assert.equal(h.probes[0].reprobe, false);
    assert.deepEqual(JSON.parse(h.infos[0]), h.recovery);
  });

  it('defaults cwd, json and reprobe on the direct-argument path', async () => {
    const h = harness();
    await runDeliverRecover({ storyId: 7 }, h.deps);
    assert.equal(h.probes[0].reprobe, true);
    assert.equal(h.infos[0], 'PROSE:merged-label-stale');
    assert.equal(typeof h.probes[0].cwd, 'string');
  });

  it('turns the stability re-probe off under --no-reprobe', async () => {
    const h = harness();
    await runDeliverRecover({ argv: ['--story', '1', '--no-reprobe'] }, h.deps);
    assert.equal(h.probes[0].reprobe, false);
  });

  it('prefers an injected config and provider over the resolver seams', async () => {
    const h = harness();
    await runDeliverRecover(
      {
        argv: ['--story', '1'],
        injectedConfig: { injected: true },
        injectedProvider: { injectedProvider: true },
      },
      h.deps,
    );
    assert.deepEqual(h.probes[0].config, { injected: true });
    assert.deepEqual(h.probes[0].provider, { injectedProvider: true });
  });

  it('builds config and provider from the seams when none are injected', async () => {
    const h = harness();
    await runDeliverRecover(
      { argv: ['--story', '1', '--cwd', '/repo'] },
      h.deps,
    );
    assert.deepEqual(h.probes[0].config, { resolvedFor: '/repo' });
    assert.deepEqual(h.probes[0].provider, { providerFor: '/repo' });
  });

  it('threads the gh, git-spawn and sleep seams to the probe only when given', async () => {
    const h = harness();
    const gh = () => {};
    const gitSpawn = () => {};
    const sleepFn = async () => {};
    await runDeliverRecover(
      {
        storyId: 1,
        injectedGh: gh,
        injectedGitSpawn: gitSpawn,
        injectedSleepFn: sleepFn,
      },
      h.deps,
    );
    assert.equal(h.probes[0].gh, gh);
    assert.equal(h.probes[0].gitSpawnFn, gitSpawn);
    assert.equal(h.probes[0].sleepFn, sleepFn);

    const bare = harness();
    await runDeliverRecover({ storyId: 1 }, bare.deps);
    assert.equal('sleepFn' in bare.probes[0], false);
  });
});
