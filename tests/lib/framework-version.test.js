// tests/lib/framework-version.test.js
/**
 * Unit tests for the framework-version helper (Story #4382).
 *
 * Covers:
 *  - resolveFrameworkVersion() returns the root package.json version and
 *    degrades to 'unknown' (never throws) when the manifest is unreadable.
 *  - formatAuthoredDate() renders YYYY-MM-DD.
 *  - stampFrameworkVersion() stamps the hidden meta field + visible marker
 *    once and is immutable on an already-stamped body.
 *  - extractFrameworkStamp() recovers the stamp (and returns null when absent).
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  authoredMarkerLine,
  extractFrameworkStamp,
  FALLBACK_VERSION,
  formatAuthoredDate,
  resolveFrameworkVersion,
  stampFrameworkVersion,
} from '../../.agents/scripts/lib/framework-version.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_PKG = path.resolve(__dirname, '../../package.json');
const PKG_VERSION = JSON.parse(fs.readFileSync(ROOT_PKG, 'utf8')).version;

describe('resolveFrameworkVersion', () => {
  it('returns the root package.json version', () => {
    assert.equal(resolveFrameworkVersion(), PKG_VERSION);
  });

  it('degrades to the fallback (unknown) when the manifest is unreadable', () => {
    const missing = path.join(__dirname, 'does-not-exist-pkg.json');
    let result;
    assert.doesNotThrow(() => {
      result = resolveFrameworkVersion({ pkgPath: missing });
    });
    assert.equal(result, FALLBACK_VERSION);
    assert.equal(FALLBACK_VERSION, 'unknown');
  });

  it('degrades to the fallback when the manifest has no version field', () => {
    const tmp = path.join(__dirname, 'framework-version-noversion.tmp.json');
    fs.writeFileSync(tmp, JSON.stringify({ name: 'x' }), 'utf8');
    try {
      assert.equal(resolveFrameworkVersion({ pkgPath: tmp }), FALLBACK_VERSION);
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  });
});

describe('formatAuthoredDate', () => {
  it('renders a fixed date as YYYY-MM-DD', () => {
    assert.equal(
      formatAuthoredDate(new Date('2026-07-07T13:45:00Z')),
      '2026-07-07',
    );
  });

  it('renders a YYYY-MM-DD shape for the default (now) argument', () => {
    assert.match(formatAuthoredDate(), /^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('stampFrameworkVersion', () => {
  it('adds the hidden meta field and the visible marker line', () => {
    const out = stampFrameworkVersion('## Goal\nDo the thing.', {
      version: '1.2.3',
      authoredAt: '2026-07-07',
    });
    assert.match(
      out,
      /<!-- meta: \{"mandrel_version":"1\.2\.3","authored_at":"2026-07-07"\} -->/,
    );
    assert.ok(out.includes('> 🏷️ Authored with Mandrel v1.2.3 · 2026-07-07'));
  });

  it('defaults to the running version + today when no stamp is supplied', () => {
    const out = stampFrameworkVersion('body');
    const stamp = extractFrameworkStamp(out);
    assert.equal(stamp.version, PKG_VERSION);
    assert.match(stamp.authoredAt, /^\d{4}-\d{2}-\d{2}$/);
  });

  it('is immutable: an already-stamped body is returned verbatim', () => {
    const once = stampFrameworkVersion('body', {
      version: '1.0.0',
      authoredAt: '2026-01-01',
    });
    const twice = stampFrameworkVersion(once, {
      version: '9.9.9',
      authoredAt: '2026-12-31',
    });
    assert.equal(twice, once);
    assert.equal(extractFrameworkStamp(twice).version, '1.0.0');
  });

  it('merges the stamp into an existing (version-less) meta block, keys last', () => {
    const withMeta = 'body\n\n<!-- meta: {"estimated_test_files":2} -->';
    const out = stampFrameworkVersion(withMeta, {
      version: '2.0.0',
      authoredAt: '2026-02-02',
    });
    assert.match(
      out,
      /<!-- meta: \{"estimated_test_files":2,"mandrel_version":"2\.0\.0","authored_at":"2026-02-02"\} -->/,
    );
  });
});

describe('extractFrameworkStamp', () => {
  it('recovers the version + authoredAt from a stamped body', () => {
    const out = stampFrameworkVersion('body', {
      version: '3.3.3',
      authoredAt: '2026-03-03',
    });
    assert.deepEqual(extractFrameworkStamp(out), {
      version: '3.3.3',
      authoredAt: '2026-03-03',
    });
  });

  it('returns null for a body with no stamp', () => {
    assert.equal(extractFrameworkStamp('## Goal\nno stamp here'), null);
    assert.equal(
      extractFrameworkStamp(
        'body\n\n<!-- meta: {"estimated_test_files":1} -->',
      ),
      null,
    );
  });

  it('returns null for a malformed meta block', () => {
    assert.equal(
      extractFrameworkStamp('body\n\n<!-- meta: {not json} -->'),
      null,
    );
  });
});

describe('authoredMarkerLine', () => {
  it('renders the canonical marker string', () => {
    assert.equal(
      authoredMarkerLine({ version: '1.86.0', authoredAt: '2026-07-07' }),
      '> 🏷️ Authored with Mandrel v1.86.0 · 2026-07-07',
    );
  });
});
