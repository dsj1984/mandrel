/**
 * tests/check-npm-audit.test.js — Story #5559.
 *
 * The SCA gate may suppress an advisory only on mechanical evidence: a
 * committed exception, absence from the production (`--omit=dev`) audit, and
 * an unexpired review date. Every way an exception can stop being true must
 * put the advisory back in the way of the build, and a broken exceptions file
 * must fail closed rather than quietly disable the audit.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { parseArgs, runCheck } from '../scripts/check-npm-audit.js';
import {
  auditWithExceptions,
  loadExceptions,
} from '../scripts/lib/audit-exceptions.js';

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

const TODAY = '2026-10-07';
const BRACES = 'GHSA-vfj7-8cjw-p6xm';
const OTHER = 'GHSA-aaaa-bbbb-cccc';

const bracesAdvisory = {
  source: 1240992,
  name: 'braces',
  title: 'braces stack exhaustion',
  url: `https://github.com/advisories/${BRACES}`,
  severity: 'high',
};

/** The dev-only braces chain, shaped as `npm audit --json` reports it. */
const BRACES_CHAIN = {
  braces: { severity: 'high', via: [bracesAdvisory] },
  micromatch: { severity: 'high', via: ['braces'] },
  'markdownlint-cli2': { severity: 'high', via: ['micromatch', 'smol-toml'] },
  'smol-toml': {
    severity: 'moderate',
    via: [
      {
        source: 2,
        name: 'smol-toml',
        title: 'moderate only',
        url: 'https://github.com/advisories/GHSA-zzzz-zzzz-zzzz',
        severity: 'moderate',
      },
    ],
  },
};

const OTHER_CHAIN = {
  other: {
    severity: 'critical',
    via: [
      {
        source: 99,
        name: 'other',
        title: 'other advisory',
        url: `https://github.com/advisories/${OTHER}`,
        severity: 'critical',
      },
    ],
  },
};

const report = (vulnerabilities) => ({ vulnerabilities });
const EMPTY = report({});

const bracesException = (overrides = {}) => ({
  id: BRACES,
  package: 'braces',
  reason: 'dev-only, no patched release',
  reviewBy: '2027-01-05',
  ...overrides,
});

/** A fake npm that answers the full and `--omit=dev` audits separately. */
function fakeSpawn({ full, production = EMPTY }) {
  return (cmd, args) => {
    assert.equal(cmd, 'npm');
    const json = args.includes('--omit=dev') ? production : full;
    return { stdout: JSON.stringify(json), stderr: '' };
  };
}

function gate({ full, production, exceptions, today = TODAY, loadThrows }) {
  const log = { info: [], error: [] };
  const out = runCheck(['node', 'check-npm-audit.js'], {
    load: () => {
      if (loadThrows) throw new Error(loadThrows);
      return exceptions;
    },
    audit: (dir, opts) =>
      auditWithExceptions(dir, {
        ...opts,
        spawn: fakeSpawn({ full, production }),
      }),
    today,
    logger: {
      info: (m) => log.info.push(m),
      error: (m) => log.error.push(m),
    },
  });
  return { ...out, text: out.lines.join('\n'), log };
}

describe('check-npm-audit — the gate', () => {
  it('passes a clean tree', () => {
    const out = gate({ full: EMPTY, exceptions: [] });
    assert.equal(out.exitCode, 0);
  });

  it('suppresses a dev-only, unexpired, excepted advisory and its whole chain', () => {
    const out = gate({
      full: report(BRACES_CHAIN),
      exceptions: [bracesException()],
    });
    assert.equal(out.exitCode, 0);
    assert.match(
      out.text,
      /excepted: GHSA-vfj7-8cjw-p6xm \(braces\) — review by 2027-01-05/,
    );
    assert.match(out.text, /3 audit entries suppressed/);
    assert.doesNotMatch(out.text, /blocking:/);
  });

  it('fails on a blocking advisory with no exception', () => {
    const out = gate({ full: report(BRACES_CHAIN), exceptions: [] });
    assert.equal(out.exitCode, 1);
    assert.match(out.text, /✗ blocking: advisory:1240992 \(high\)/);
    assert.match(out.text, /✗ blocking: package:micromatch/);
  });

  it('keeps blocking an unexcepted advisory alongside an honored one', () => {
    const out = gate({
      full: report({ ...BRACES_CHAIN, ...OTHER_CHAIN }),
      exceptions: [bracesException()],
    });
    assert.equal(out.exitCode, 1);
    assert.match(out.text, /✗ blocking: advisory:99 \(critical\)/);
    assert.doesNotMatch(out.text, /advisory:1240992/);
  });

  it('never honors an exception for an advisory production code reaches', () => {
    const out = gate({
      full: report(BRACES_CHAIN),
      production: report({ braces: BRACES_CHAIN.braces }),
      exceptions: [bracesException()],
    });
    assert.equal(out.exitCode, 1);
    assert.match(
      out.text,
      /✗ exception not honored: GHSA-vfj7-8cjw-p6xm \(braces\) — reachable in production/,
    );
    assert.match(out.text, /✗ blocking: advisory:1240992/);
  });

  it('stops honoring an exception the day after its reviewBy date', () => {
    const onTheDay = gate({
      full: report(BRACES_CHAIN),
      exceptions: [bracesException({ reviewBy: TODAY })],
    });
    assert.equal(onTheDay.exitCode, 0);

    const after = gate({
      full: report(BRACES_CHAIN),
      exceptions: [bracesException({ reviewBy: '2026-10-06' })],
    });
    assert.equal(after.exitCode, 1);
    assert.match(after.text, /exception expired 2026-10-06/);
    assert.match(after.text, /✗ blocking: advisory:1240992/);
  });

  it('fails on a stale exception that matches no current advisory', () => {
    const out = gate({ full: EMPTY, exceptions: [bracesException()] });
    assert.equal(out.exitCode, 1);
    assert.match(out.text, /✗ stale exception: GHSA-vfj7-8cjw-p6xm \(braces\)/);
  });

  it('treats an exception naming the wrong package as stale', () => {
    const out = gate({
      full: report(BRACES_CHAIN),
      exceptions: [bracesException({ package: 'micromatch' })],
    });
    assert.equal(out.exitCode, 1);
    assert.match(out.text, /stale exception/);
    assert.match(out.text, /✗ blocking: advisory:1240992/);
  });

  it('fails closed when the exceptions file is invalid', () => {
    const out = gate({ full: EMPTY, loadThrows: 'failed validation' });
    assert.equal(out.exitCode, 1);
    assert.match(out.text, /could not run: failed validation/);
  });

  it('fails closed when npm cannot evaluate the tree', () => {
    const log = [];
    const out = runCheck(['node', 'x'], {
      load: () => [],
      audit: (dir, opts) =>
        auditWithExceptions(dir, {
          ...opts,
          spawn: () => ({ stdout: 'not json', stderr: 'ENOLOCK' }),
        }),
      logger: { info: (m) => log.push(m), error: (m) => log.push(m) },
    });
    assert.equal(out.exitCode, 1);
    assert.match(out.lines.join('\n'), /could not evaluate the tree: ENOLOCK/);
  });
});

describe('loadExceptions', () => {
  const read = (body) => () => body;
  const valid = { exceptions: [bracesException()] };

  it('reads a valid file', () => {
    assert.deepEqual(
      loadExceptions('/repo', { readFile: read(JSON.stringify(valid)) }),
      valid.exceptions,
    );
  });

  it('treats a missing file as no exceptions', () => {
    const readFile = () => {
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    };
    assert.deepEqual(loadExceptions('/repo', { readFile }), []);
  });

  for (const [label, body, pattern] of [
    ['malformed JSON', '{ nope', /not valid JSON/],
    [
      'a missing reviewBy',
      { exceptions: [{ id: BRACES, package: 'braces', reason: 'r' }] },
      /reviewBy/,
    ],
    [
      'a non-GHSA id',
      { exceptions: [bracesException({ id: 'CVE-1' })] },
      /pattern/,
    ],
    [
      'an impossible date',
      { exceptions: [bracesException({ reviewBy: '2027-02-30' })] },
      /format/,
    ],
    [
      'an unknown key',
      { exceptions: [bracesException({ extra: 1 })] },
      /additional/,
    ],
    ['an unknown top-level key', { ...valid, notes: 'x' }, /additional/],
    [
      'a duplicate id',
      { exceptions: [bracesException(), bracesException()] },
      /more than once/,
    ],
  ]) {
    it(`rejects ${label}`, () => {
      const raw = typeof body === 'string' ? body : JSON.stringify(body);
      assert.throws(
        () => loadExceptions('/repo', { readFile: read(raw) }),
        pattern,
      );
    });
  }

  it('accepts the committed audit-exceptions.json', () => {
    const exceptions = loadExceptions(REPO_ROOT);
    assert.ok(Array.isArray(exceptions));
  });
});

describe('parseArgs', () => {
  it('reads --cwd', () => {
    assert.equal(parseArgs(['node', 'x', '--cwd', '/repo']).cwd, '/repo');
  });
});
