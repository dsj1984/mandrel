// lib/migrations/steps/__tests__/2.91.0-move-shared-crap-capture-script.test.js
/**
 * The 2.91.0 step moves a CRAP `captureScript` that has no own artifact to the
 * coverage gate, so a config the resolver now refuses resolves after
 * `mandrel update`. Unit tier: an in-memory fs, no real I/O.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';

import { moveSharedCrapCaptureScript as step } from '../2.91.0-move-shared-crap-capture-script.js';

const ROOT = '/consumer';
const BASE = path.join(ROOT, '.agentrc.json');
const LOCAL = path.join(ROOT, '.agentrc.local.json');

function makeCtx(filesByPath) {
  const files = new Map(
    Object.entries(filesByPath).map(([p, c]) => [p, JSON.stringify(c)]),
  );
  const fs = {
    readFileSync(p) {
      if (!files.has(p))
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return files.get(p);
    },
    writeFileSync(p, c) {
      files.set(p, c);
    },
  };
  return {
    ctx: { projectRoot: ROOT, fs },
    read: (p) => JSON.parse(files.get(p)),
  };
}

const withGates = (gates) => ({ delivery: { quality: { gates } } });

describe('2.91.0 move-shared-crap-capture-script', () => {
  it('moves a shared CRAP captureScript to the coverage gate', () => {
    const { ctx, read } = makeCtx({
      [BASE]: withGates({ crap: { enabled: true, captureScript: 'cov' } }),
    });
    assert.equal(step.detect(ctx), true);
    step.apply(ctx);
    assert.deepEqual(read(BASE).delivery.quality.gates, {
      crap: { enabled: true },
      coverage: { captureScript: 'cov' },
    });
    assert.equal(step.detect(ctx), false);
  });

  it('treats a coveragePath equal to the coverage artifact as shared, and keeps an explicit coverage script', () => {
    const { ctx, read } = makeCtx({
      [LOCAL]: withGates({
        crap: {
          coveragePath: 'coverage\\coverage-final.json',
          captureScript: 'a',
        },
        coverage: { captureScript: 'b' },
      }),
    });
    step.apply(ctx);
    const gates = read(LOCAL).delivery.quality.gates;
    assert.equal(gates.crap.captureScript, undefined);
    assert.equal(gates.coverage.captureScript, 'b');
  });

  it('leaves an own CRAP source and configs without the key untouched', () => {
    const { ctx } = makeCtx({
      [BASE]: withGates({
        crap: { coveragePath: 'coverage-py/c.json', captureScript: 'py' },
      }),
      [LOCAL]: { github: { operatorHandle: '@x' } },
    });
    assert.equal(step.detect(ctx), false);
    assert.equal(step.detect(makeCtx({}).ctx), false, 'no config at all');
  });
});
