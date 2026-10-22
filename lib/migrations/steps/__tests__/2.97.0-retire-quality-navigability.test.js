// lib/migrations/steps/__tests__/2.97.0-retire-quality-navigability.test.js
/**
 * Story #5850 — `delivery.quality.navigability` is retired in favour of
 * `planning.navigation`. Drives `detect`/`apply` against an in-memory fs over
 * both config surfaces.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';

import { retireQualityNavigability } from '../2.97.0-retire-quality-navigability.js';

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
  const lines = [];
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
    ctx: { projectRoot: PROJECT_ROOT, fs, log: (line) => lines.push(line) },
    read: (p) => JSON.parse(files.get(p)),
    lines,
    writes: () => writes,
  };
}

const withNavigability = (navigability, planning) => ({
  ...(planning ? { planning: { navigation: planning } } : {}),
  delivery: { quality: { navigability, gates: { crap: { enabled: true } } } },
});

describe('retireQualityNavigability', () => {
  it('ships at 2.97.0 naming the retired block', () => {
    assert.equal(retireQualityNavigability.version, '2.97.0');
    assert.match(
      retireQualityNavigability.description,
      /delivery\.quality\.navigability/,
    );
  });

  it('detects nothing on a config without the block, or with no config', () => {
    const clean = makeCtx({
      [BASE]: { planning: { navigation: { routeGlobs: ['app/**'] } } },
    });
    assert.equal(retireQualityNavigability.detect(clean.ctx), false);
    assert.equal(retireQualityNavigability.detect(makeCtx({}).ctx), false);
  });

  it('strips the block from .agentrc.json, keeping planning.navigation and siblings', () => {
    const { ctx, read, lines } = makeCtx({
      [BASE]: withNavigability(
        { routeGlobs: ['app/**'], journeySuite: 'npm run journeys' },
        { routeGlobs: ['app/**'] },
      ),
    });
    assert.equal(retireQualityNavigability.detect(ctx), true);
    retireQualityNavigability.apply(ctx);
    assert.deepEqual(read(BASE), {
      planning: { navigation: { routeGlobs: ['app/**'] } },
      delivery: { quality: { gates: { crap: { enabled: true } } } },
    });
    assert.deepEqual(lines, [
      '  removed .agentrc.json delivery.quality.navigability.routeGlobs; planning.navigation.routeGlobs already carries it',
      '  removed .agentrc.json delivery.quality.navigability.journeySuite; it had no reader',
    ]);
  });

  it('reports a value planning.navigation does not carry as a behaviour change', () => {
    const { ctx, read, lines } = makeCtx({
      [BASE]: { project: { baseBranch: 'main' } },
      [LOCAL]: withNavigability({ navRegistry: ['src/nav.ts'] }),
    });
    retireQualityNavigability.apply(ctx);
    assert.equal(read(LOCAL).delivery.quality.navigability, undefined);
    assert.equal(read(LOCAL).planning, undefined, 'values are never moved');
    assert.deepEqual(lines, [
      '  behaviour change: .agentrc.local.json set delivery.quality.navigability.navRegistry = ["src/nav.ts"]; set planning.navigation.navRegistry to keep it',
    ]);
    assert.deepEqual(
      read(BASE),
      { project: { baseBranch: 'main' } },
      'a surface without the block is left untouched',
    );
  });

  it('is idempotent: a second pass detects nothing, logs nothing and writes nothing', () => {
    const { ctx, writes, lines } = makeCtx({
      [BASE]: withNavigability({ routeGlobs: ['pages/**'] }),
      [LOCAL]: withNavigability({ journeySuite: 'x' }),
    });
    retireQualityNavigability.apply(ctx);
    assert.equal(writes(), 2);
    const logged = lines.length;
    assert.equal(retireQualityNavigability.detect(ctx), false);
    retireQualityNavigability.apply(ctx);
    assert.equal(writes(), 2);
    assert.equal(lines.length, logged);
  });
});
