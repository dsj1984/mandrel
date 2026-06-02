/**
 * install-matrix-assert.test — Story #3472 (Feature #3464, Epic #3436).
 *
 * Unit-tests the golden-path install assertions that
 * `.github/workflows/install-matrix.yml` runs in every matrix leg. Each check
 * is driven through the script's injectable seams (`fs`, `write`, `writeErr`)
 * so no real filesystem is touched — an in-memory volume (memfs) stands in.
 *
 * Coverage contract:
 *   - parseArgs: flag/value forms, repeated --check, default check set
 *   - checkMaterialized: pass when instructions.md present, fail when absent
 *   - checkManifestClean: pass for a clean manifest (framework pkg allowed),
 *     fail when a framework runtime dep leaked into the consumer manifest
 *   - checkDoctorReady: pass on the "✅  Ready" marker, fail without it,
 *     fail when --doctor-output is missing
 *   - runAssertions: aggregate ok, missing --consumer guard, per-check report
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createFsFromVolume, Volume } from 'memfs';

import {
  checkDoctorReady,
  checkManifestClean,
  checkMaterialized,
  parseArgs,
  runAssertions,
} from '../../.agents/scripts/install-matrix-assert.js';

/**
 * Build an in-memory fs from a path→content map.
 *
 * @param {Record<string, string>} files
 * @returns {import('node:fs')}
 */
function makeFs(files) {
  const vol = Volume.fromJSON(files);
  return /** @type {import('node:fs')} */ (createFsFromVolume(vol));
}

// ---------------------------------------------------------------------------
// parseArgs
// ---------------------------------------------------------------------------

describe('parseArgs', () => {
  it('parses --flag value form', () => {
    const opts = parseArgs(['--consumer', '/c', '--doctor-output', '/d.txt']);
    assert.equal(opts.consumer, '/c');
    assert.equal(opts.doctorOutput, '/d.txt');
  });

  it('parses --flag=value form', () => {
    const opts = parseArgs(['--consumer=/c', '--package-name=@x/y']);
    assert.equal(opts.consumer, '/c');
    assert.equal(opts.packageName, '@x/y');
  });

  it('accumulates repeated --check flags', () => {
    const opts = parseArgs([
      '--consumer',
      '/c',
      '--check',
      'materialized',
      '--check',
      'manifest-clean',
    ]);
    assert.deepEqual(opts.checks, ['materialized', 'manifest-clean']);
  });

  it('defaults to all checks when none are passed', () => {
    const opts = parseArgs(['--consumer', '/c']);
    assert.deepEqual(opts.checks, [
      'materialized',
      'manifest-clean',
      'doctor-ready',
    ]);
  });

  it('defaults the package name to @mandrel/agents', () => {
    const opts = parseArgs(['--consumer', '/c']);
    assert.equal(opts.packageName, '@mandrel/agents');
  });
});

// ---------------------------------------------------------------------------
// checkMaterialized
// ---------------------------------------------------------------------------

describe('checkMaterialized', () => {
  it('passes when .agents/instructions.md exists', () => {
    const fs = makeFs({ '/c/.agents/instructions.md': '# hi' });
    const r = checkMaterialized({ consumer: '/c', fs });
    assert.equal(r.ok, true);
    assert.match(r.detail, /materialized/);
  });

  it('fails when .agents/instructions.md is absent', () => {
    const fs = makeFs({ '/c/package.json': '{}' });
    const r = checkMaterialized({ consumer: '/c', fs });
    assert.equal(r.ok, false);
    assert.match(r.detail, /did not materialize/);
  });
});

// ---------------------------------------------------------------------------
// checkManifestClean
// ---------------------------------------------------------------------------

describe('checkManifestClean', () => {
  it('passes when only the framework package and own deps are declared', () => {
    const fs = makeFs({
      '/c/package.json': JSON.stringify({
        dependencies: { '@mandrel/agents': 'file:../x.tgz', 'left-pad': '^1' },
      }),
    });
    const r = checkManifestClean({
      consumer: '/c',
      packageName: '@mandrel/agents',
      fs,
    });
    assert.equal(r.ok, true);
    assert.match(r.detail, /no framework runtime deps leaked/);
  });

  it('passes when the framework package is not declared at all', () => {
    const fs = makeFs({
      '/c/package.json': JSON.stringify({ dependencies: { 'left-pad': '^1' } }),
    });
    const r = checkManifestClean({
      consumer: '/c',
      packageName: '@mandrel/agents',
      fs,
    });
    assert.equal(r.ok, true);
  });

  it('fails when a framework runtime dep leaked into the manifest', () => {
    const fs = makeFs({
      '/c/package.json': JSON.stringify({
        dependencies: { '@mandrel/agents': 'file:../x.tgz', 'js-yaml': '^4' },
      }),
    });
    const r = checkManifestClean({
      consumer: '/c',
      packageName: '@mandrel/agents',
      fs,
    });
    assert.equal(r.ok, false);
    assert.match(r.detail, /js-yaml/);
  });

  it('inspects devDependencies and peerDependencies too', () => {
    const fs = makeFs({
      '/c/package.json': JSON.stringify({
        dependencies: {},
        devDependencies: { ajv: '^8' },
      }),
    });
    const r = checkManifestClean({
      consumer: '/c',
      packageName: '@mandrel/agents',
      fs,
    });
    assert.equal(r.ok, false);
    assert.match(r.detail, /ajv/);
  });

  it('fails with an actionable message when package.json is unreadable', () => {
    const fs = makeFs({ '/c/other.json': '{}' });
    const r = checkManifestClean({
      consumer: '/c',
      packageName: '@mandrel/agents',
      fs,
    });
    assert.equal(r.ok, false);
    assert.match(r.detail, /could not read consumer package.json/);
  });
});

// ---------------------------------------------------------------------------
// checkDoctorReady
// ---------------------------------------------------------------------------

describe('checkDoctorReady', () => {
  it('passes when the ready marker is present', () => {
    const fs = makeFs({
      '/d.txt': '✔  node-version  ok\n✅  Ready (8/8 checks passed)\n',
    });
    const r = checkDoctorReady({ doctorOutput: '/d.txt', fs });
    assert.equal(r.ok, true);
  });

  it('fails when the ready marker is absent', () => {
    const fs = makeFs({
      '/d.txt':
        '✘  gh-auth  not logged in\n❌  Not ready (1/8 checks failed)\n',
    });
    const r = checkDoctorReady({ doctorOutput: '/d.txt', fs });
    assert.equal(r.ok, false);
    assert.match(r.detail, /did not report a ready verdict/);
  });

  it('fails when --doctor-output was not provided', () => {
    const fs = makeFs({});
    const r = checkDoctorReady({ fs });
    assert.equal(r.ok, false);
    assert.match(r.detail, /--doctor-output/);
  });

  it('fails with an actionable message when the output file is missing', () => {
    const fs = makeFs({});
    const r = checkDoctorReady({ doctorOutput: '/missing.txt', fs });
    assert.equal(r.ok, false);
    assert.match(r.detail, /could not read doctor output/);
  });
});

// ---------------------------------------------------------------------------
// runAssertions
// ---------------------------------------------------------------------------

describe('runAssertions', () => {
  it('returns ok when every requested check passes', () => {
    const fs = makeFs({
      '/c/.agents/instructions.md': '# hi',
      '/c/package.json': JSON.stringify({
        dependencies: { '@mandrel/agents': 'file:../x.tgz' },
      }),
    });
    const lines = [];
    const out = runAssertions({
      argv: [
        '--consumer',
        '/c',
        '--check',
        'materialized',
        '--check',
        'manifest-clean',
      ],
      fs,
      write: (s) => lines.push(s),
      writeErr: (s) => lines.push(s),
    });
    assert.equal(out.ok, true);
    assert.equal(out.results.length, 2);
    assert.ok(lines.join('').includes('[PASS] materialized'));
  });

  it('returns not-ok and reports the failing check', () => {
    const fs = makeFs({
      '/c/package.json': JSON.stringify({ dependencies: { ajv: '^8' } }),
    });
    const errLines = [];
    const out = runAssertions({
      argv: ['--consumer', '/c', '--check', 'manifest-clean'],
      fs,
      write: () => {},
      writeErr: (s) => errLines.push(s),
    });
    assert.equal(out.ok, false);
    assert.ok(errLines.join('').includes('[FAIL] manifest-clean'));
  });

  it('guards against a missing --consumer flag', () => {
    const errLines = [];
    const out = runAssertions({
      argv: ['--check', 'materialized'],
      fs: makeFs({}),
      write: () => {},
      writeErr: (s) => errLines.push(s),
    });
    assert.equal(out.ok, false);
    assert.match(errLines.join(''), /--consumer <dir> is required/);
  });
});
