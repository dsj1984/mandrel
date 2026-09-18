// lib/migrations/steps/__tests__/2.60.0-retire-audit-results-autofile.test.js
/**
 * Unit tests for the Story #5366 migration step — strips the retired
 * `delivery.feedbackLoop.auditResultsAutoFile` key from a consumer's config.
 * All tests drive `detect`/`apply` against an in-memory fake fs
 * (testing-standards § Unit) — no real filesystem I/O.
 *
 * Two properties carry the Story's acceptance:
 *
 *   - the key is stripped from **both** config surfaces, because the resolver
 *     merges `.agentrc.local.json` over `.agentrc.json` before AJV runs;
 *   - the sibling `retroProposals` toggle survives untouched — it still has a
 *     live reader, and a retire step that took it too would silently disable
 *     a feature the consumer asked for.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';

import { retireAuditResultsAutoFile } from '../2.60.0-retire-audit-results-autofile.js';

const PROJECT_ROOT = '/consumer';
const AGENTRC_PATH = path.join(PROJECT_ROOT, '.agentrc.json');
const AGENTRC_LOCAL_PATH = path.join(PROJECT_ROOT, '.agentrc.local.json');

/**
 * @param {{ base?: object|null, local?: object|null }} initial - `null` (or an
 *   omitted key) means no file on disk for that surface.
 * @returns {{ ctx: object, read: (p: string) => object, writes: () => number }}
 */
function makeCtx({ base = null, local = null } = {}) {
  const files = new Map();
  let writes = 0;
  if (base !== null) files.set(AGENTRC_PATH, JSON.stringify(base, null, 2));
  if (local !== null)
    files.set(AGENTRC_LOCAL_PATH, JSON.stringify(local, null, 2));

  const fs = {
    readFileSync(filePath) {
      if (!files.has(filePath)) {
        const err = new Error(`ENOENT: ${filePath}`);
        err.code = 'ENOENT';
        throw err;
      }
      return files.get(filePath);
    },
    writeFileSync(filePath, contents) {
      writes += 1;
      files.set(filePath, contents);
    },
  };

  return {
    ctx: { projectRoot: PROJECT_ROOT, fs },
    read: (filePath) => JSON.parse(files.get(filePath)),
    writes: () => writes,
  };
}

const WITH_KEY = {
  project: { paths: { agentRoot: '.agents' } },
  delivery: { feedbackLoop: { auditResultsAutoFile: false } },
};

describe('retireAuditResultsAutoFile — detect', () => {
  it('detects the key at either value', () => {
    for (const value of [true, false]) {
      const { ctx } = makeCtx({
        base: { delivery: { feedbackLoop: { auditResultsAutoFile: value } } },
      });
      assert.equal(retireAuditResultsAutoFile.detect(ctx), true, String(value));
    }
  });

  it('detects the key in the gitignored local overlay too', () => {
    const { ctx } = makeCtx({
      base: { project: {} },
      local: { delivery: { feedbackLoop: { auditResultsAutoFile: true } } },
    });
    assert.equal(retireAuditResultsAutoFile.detect(ctx), true);
  });

  it('does not detect a feedbackLoop block carrying only surviving keys', () => {
    const { ctx } = makeCtx({
      base: {
        delivery: {
          feedbackLoop: { retroProposals: true, frictionWindowDays: 14 },
        },
      },
    });
    assert.equal(retireAuditResultsAutoFile.detect(ctx), false);
  });

  it('does not detect an absent delivery block or an absent config', () => {
    assert.equal(
      retireAuditResultsAutoFile.detect(makeCtx({ base: {} }).ctx),
      false,
    );
    assert.equal(retireAuditResultsAutoFile.detect(makeCtx().ctx), false);
  });
});

describe('retireAuditResultsAutoFile — apply', () => {
  it('strips the key and prunes the emptied feedbackLoop and delivery blocks', () => {
    const { ctx, read } = makeCtx({ base: WITH_KEY });
    retireAuditResultsAutoFile.apply(ctx);
    const config = read(AGENTRC_PATH);
    assert.equal(Object.hasOwn(config, 'delivery'), false);
    assert.deepEqual(config.project, { paths: { agentRoot: '.agents' } });
  });

  it('leaves the retroProposals toggle alone — it still has a live reader', () => {
    const { ctx, read } = makeCtx({
      base: {
        delivery: {
          feedbackLoop: {
            auditResultsAutoFile: true,
            retroProposals: true,
            frictionWindowDays: 14,
          },
        },
      },
    });
    retireAuditResultsAutoFile.apply(ctx);
    assert.deepEqual(read(AGENTRC_PATH).delivery.feedbackLoop, {
      retroProposals: true,
      frictionWindowDays: 14,
    });
  });

  it('sweeps the local overlay, not just the committed base', () => {
    const { ctx, read } = makeCtx({
      base: { project: { paths: {} } },
      local: {
        delivery: {
          feedbackLoop: { auditResultsAutoFile: true, retroProposals: false },
        },
      },
    });
    retireAuditResultsAutoFile.apply(ctx);
    assert.deepEqual(read(AGENTRC_LOCAL_PATH).delivery.feedbackLoop, {
      retroProposals: false,
    });
  });

  it('is idempotent — a second run detects nothing and writes nothing', () => {
    const { ctx, writes } = makeCtx({ base: WITH_KEY });
    retireAuditResultsAutoFile.apply(ctx);
    const afterFirst = writes();
    assert.equal(retireAuditResultsAutoFile.detect(ctx), false);
    retireAuditResultsAutoFile.apply(ctx);
    assert.equal(writes(), afterFirst);
  });

  it('carries the 2.60.0 version and names the retired key', () => {
    assert.equal(retireAuditResultsAutoFile.version, '2.60.0');
    assert.match(
      retireAuditResultsAutoFile.description,
      /auditResultsAutoFile/,
    );
  });
});
