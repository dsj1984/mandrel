import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  handoffStatePath,
  readCreditTimings,
} from '../../../.agents/scripts/lib/orchestration/handoff-state.js';
import { makeTempDir } from '../../../.agents/scripts/lib/test-temp.js';

/** Story #5879 — close reads the credited run's figures from handoff state. */
describe('handoff-state — readCreditTimings', () => {
  let tempRoot;
  const config = () => ({ project: { paths: { tempRoot } } });
  const spawn = { lockWaitMs: 10, hostWaitMs: null, testRunMs: 20 };
  const write = (state) => {
    const dir = path.join(tempRoot, 'orchestration');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(handoffStatePath(dir, 7), JSON.stringify({ state }));
  };

  beforeEach(() => {
    tempRoot = makeTempDir('handoff-state-');
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('returns the timings keyed to the current credit head', () => {
    const creditTimings = {
      head: 'h1',
      lockWait: null,
      suiteTimings: spawn,
      spawns: [spawn],
    };
    write({ creditHead: 'h1', creditTimings });
    assert.deepEqual(readCreditTimings(7, config()), creditTimings);
  });

  it('is null when absent, corrupt, keyed to a stale head or suite-less', () => {
    assert.equal(readCreditTimings(7, config()), null, 'absent');
    write({
      creditHead: 'h2',
      creditTimings: { head: 'h1', suiteTimings: spawn, spawns: [spawn] },
    });
    assert.equal(readCreditTimings(7, config()), null, 'stale head');
    write({
      creditHead: 'h1',
      creditTimings: { head: 'h1', suiteTimings: null, spawns: [] },
    });
    assert.equal(readCreditTimings(7, config()), null, 'no suite ran');
    fs.writeFileSync(
      handoffStatePath(path.join(tempRoot, 'orchestration'), 7),
      '{',
    );
    assert.equal(readCreditTimings(7, config()), null, 'corrupt');
  });

  // Story #5937 — the lint carry-forward and post-capture keys share the file.
  it('reads the credit beside the lint credit and post-capture head', () => {
    const creditTimings = { head: 'h1', suiteTimings: spawn, spawns: [spawn] };
    write({
      creditHead: 'h1',
      creditTimings,
      lintCredit: { head: 'h1', configHash: 'sha256:x' },
      postCaptureHead: 'h1',
    });
    assert.deepEqual(readCreditTimings(7, config()), creditTimings);
  });
});
