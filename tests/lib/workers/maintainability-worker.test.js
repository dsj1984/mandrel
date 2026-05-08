import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { handleMaintainabilityWorkerMessage } from '../../../.agents/scripts/lib/workers/maintainability-worker.js';

describe('handleMaintainabilityWorkerMessage — control messages', () => {
  it('exit:true returns kind=exit', () => {
    assert.deepEqual(handleMaintainabilityWorkerMessage({ exit: true }), {
      kind: 'exit',
    });
  });

  it('rejects null/undefined messages', () => {
    const out = handleMaintainabilityWorkerMessage(null);
    assert.equal(out.kind, 'reply');
    assert.equal(out.message.ok, false);
    assert.match(out.message.error, /bad worker message/);
  });

  it('rejects messages with non-string item', () => {
    const out = handleMaintainabilityWorkerMessage({ item: 42 });
    assert.equal(out.message.ok, false);
  });
});

describe('handleMaintainabilityWorkerMessage — score path', () => {
  it('returns the computed score on success', () => {
    const out = handleMaintainabilityWorkerMessage(
      { item: '/abs/foo.js' },
      { score: () => 87.5 },
    );
    assert.equal(out.message.ok, true);
    assert.deepEqual(out.message.result, {
      filePath: '/abs/foo.js',
      score: 87.5,
    });
  });

  it('honors null score (file present but escomplex returns null)', () => {
    const out = handleMaintainabilityWorkerMessage(
      { item: '/abs/foo.js' },
      { score: () => null },
    );
    assert.equal(out.message.result.score, null);
    assert.equal('error' in out.message.result, false);
  });

  it('catches Error from score(), surfaces null + .error message', () => {
    const out = handleMaintainabilityWorkerMessage(
      { item: '/abs/foo.js' },
      {
        score: () => {
          throw new Error('disk full');
        },
      },
    );
    assert.equal(out.message.ok, true);
    assert.equal(out.message.result.score, null);
    assert.equal(out.message.result.error, 'disk full');
  });

  it('catches non-Error throws and stringifies them', () => {
    const out = handleMaintainabilityWorkerMessage(
      { item: '/abs/foo.js' },
      {
        score: () => {
          throw 'string thrown';
        },
      },
    );
    assert.equal(out.message.result.error, 'string thrown');
  });
});
