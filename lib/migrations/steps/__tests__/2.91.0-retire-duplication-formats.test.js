// lib/migrations/steps/__tests__/2.91.0-retire-duplication-formats.test.js
/**
 * Story #5738 — the jscpd formats derive from the scorable-extension list, so
 * `delivery.quality.gates.duplication.formats` is retired. Drives
 * `detect`/`apply` against an in-memory fs over both config surfaces.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';

import { retireDuplicationFormats } from '../2.91.0-retire-duplication-formats.js';

const PROJECT_ROOT = '/consumer';
// The step joins the same way, so the keys match on every platform.
const BASE = path.join(PROJECT_ROOT, '.agentrc.json');
const LOCAL = path.join(PROJECT_ROOT, '.agentrc.local.json');

/**
 * @param {Record<string, object>} initial path → config
 */
function makeCtx(initial) {
  const files = new Map(
    Object.entries(initial).map(([p, c]) => [p, JSON.stringify(c, null, 2)]),
  );
  let writes = 0;
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
    read: (p) => JSON.parse(files.get(p)),
    writes: () => writes,
  };
}

const withDuplication = (duplication) => ({
  project: { paths: { agentRoot: '.agents' } },
  delivery: {
    quality: { gates: { duplication, crap: { enabled: true } } },
  },
});

describe('retireDuplicationFormats', () => {
  it('ships at 2.91.0 naming the retired key', () => {
    assert.equal(retireDuplicationFormats.version, '2.91.0');
    assert.match(retireDuplicationFormats.description, /duplication\.formats/);
  });

  it('detects nothing on a config without the key, or with no config', () => {
    const clean = makeCtx({
      [BASE]: withDuplication({ targetDirs: ['src'] }),
    });
    assert.equal(retireDuplicationFormats.detect(clean.ctx), false);
    assert.equal(retireDuplicationFormats.detect(makeCtx({}).ctx), false);
  });

  it('strips the key from .agentrc.json, keeping its siblings', () => {
    const { ctx, read } = makeCtx({
      [BASE]: withDuplication({
        enabled: true,
        targetDirs: ['src'],
        formats: ['javascript'],
      }),
    });
    assert.equal(retireDuplicationFormats.detect(ctx), true);
    retireDuplicationFormats.apply(ctx);
    assert.deepEqual(read(BASE).delivery.quality.gates, {
      duplication: { enabled: true, targetDirs: ['src'] },
      crap: { enabled: true },
    });
  });

  it('strips the key from .agentrc.local.json and prunes an emptied block', () => {
    const { ctx, read } = makeCtx({
      [BASE]: withDuplication({ targetDirs: ['src'] }),
      [LOCAL]: {
        delivery: { quality: { gates: { duplication: { formats: ['tsx'] } } } },
      },
    });
    assert.equal(retireDuplicationFormats.detect(ctx), true);
    retireDuplicationFormats.apply(ctx);
    assert.deepEqual(read(LOCAL), { delivery: { quality: { gates: {} } } });
    assert.deepEqual(
      read(BASE),
      withDuplication({ targetDirs: ['src'] }),
      'a surface without the key is left untouched',
    );
  });

  it('is idempotent: a second pass detects nothing and writes nothing', () => {
    const { ctx, writes } = makeCtx({
      [BASE]: withDuplication({ formats: ['javascript', 'typescript'] }),
      [LOCAL]: withDuplication({ formats: ['tsx'] }),
    });
    retireDuplicationFormats.apply(ctx);
    assert.equal(writes(), 2);
    assert.equal(retireDuplicationFormats.detect(ctx), false);
    retireDuplicationFormats.apply(ctx);
    assert.equal(writes(), 2);
  });
});
