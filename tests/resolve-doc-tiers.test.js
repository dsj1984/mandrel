import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseArgv, runCli } from '../.agents/scripts/resolve-doc-tiers.js';

/**
 * Story #4780 — `parseArgv` scored CRAP 36 with no test file: the `--root`
 * lookahead rules (the flag that decides which tree the context-budget
 * ratchet and the documentation lens read) were unverified.
 *
 * `runCli`'s collaborators are injected through its optional final `deps`
 * parameter (`docs/contributing/test-seams.md` rules 1 and 5) — plain functions,
 * no module mocking.
 */

describe('resolve-doc-tiers parseArgv', () => {
  it('defaults to no root and no json flag', () => {
    assert.deepEqual(parseArgv([]), { rootPath: null, json: false });
    assert.deepEqual(parseArgv(), { rootPath: null, json: false });
  });

  it('reads --root <path>', () => {
    assert.deepEqual(parseArgv(['--root', '/repo']), {
      rootPath: '/repo',
      json: false,
    });
  });

  it('ignores a --root with no value', () => {
    assert.deepEqual(parseArgv(['--root']), { rootPath: null, json: false });
  });

  it('ignores a --root immediately followed by another flag', () => {
    assert.deepEqual(parseArgv(['--root', '--json']), {
      rootPath: null,
      json: true,
    });
  });

  it('reads --json', () => {
    assert.deepEqual(parseArgv(['--json']), { rootPath: null, json: true });
  });

  it('reads both flags in either order and ignores unknown tokens', () => {
    assert.deepEqual(parseArgv(['--json', '--root', '/r', 'stray']), {
      rootPath: '/r',
      json: true,
    });
    assert.deepEqual(parseArgv(['--root', '/r', '--json']), {
      rootPath: '/r',
      json: true,
    });
  });

  it('does not treat the consumed --root value as a flag on the next pass', () => {
    assert.deepEqual(parseArgv(['--root', '--weird-but-valued']), {
      rootPath: null,
      json: false,
    });
  });
});

describe('resolve-doc-tiers runCli', () => {
  const TIERS = {
    tiers: { alwaysLoaded: [], onDemand: [{ path: 'a.md', bytes: 1 }] },
  };

  function harness() {
    const written = [];
    const seen = [];
    return {
      written,
      seen,
      stdout: { write: (s) => written.push(s) },
      deps: {
        resolveConfigImpl: () => ({ resolved: true }),
        resolveDocTiersImpl: (config, opts) => {
          seen.push({ config, opts });
          return TIERS;
        },
      },
    };
  }

  it('prints the tier map as pretty JSON and exits 0', async () => {
    const h = harness();
    const code = await runCli({ argv: [], stdout: h.stdout }, h.deps);
    assert.equal(code, 0);
    assert.deepEqual(JSON.parse(h.written.join('')), TIERS);
    assert.equal(h.written.join('').endsWith('\n'), true);
  });

  it('resolves the config through the injected seam by default', async () => {
    const h = harness();
    await runCli({ argv: [], stdout: h.stdout }, h.deps);
    assert.deepEqual(h.seen[0].config, { resolved: true });
  });

  it('prefers an explicit config over the resolver', async () => {
    const h = harness();
    await runCli(
      { argv: [], stdout: h.stdout, config: { explicit: true } },
      h.deps,
    );
    assert.deepEqual(h.seen[0].config, { explicit: true });
  });

  it('prefers an explicit root over --root', async () => {
    const h = harness();
    await runCli(
      { argv: ['--root', '/from-argv'], stdout: h.stdout, root: '/explicit' },
      h.deps,
    );
    assert.equal(h.seen[0].opts.root, '/explicit');
  });

  it('falls back to the --root argv value', async () => {
    const h = harness();
    await runCli({ argv: ['--root', '/from-argv'], stdout: h.stdout }, h.deps);
    assert.equal(h.seen[0].opts.root, '/from-argv');
  });

  it('falls back to the project root when neither is supplied', async () => {
    const h = harness();
    await runCli({ argv: [], stdout: h.stdout }, h.deps);
    assert.equal(typeof h.seen[0].opts.root, 'string');
    assert.ok(h.seen[0].opts.root.length > 0);
  });
});
