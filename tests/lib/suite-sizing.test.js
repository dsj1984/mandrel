import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  runSizeCommand,
  sizeWorkload,
} from '../../.agents/scripts/lib/suite-sizing.js';

/** Story #5963 — sizing a declared workload before it reserves. */

const TIERS = [
  { maxFiles: 200, weight: 8 },
  { maxFiles: 20, weight: 2 },
  { maxFiles: 80, weight: 4 },
];

const WORKLOAD = {
  kind: 'declared',
  command: 'pnpm run test:coverage:affected',
  weight: 8,
  resources: [],
  tiers: TIERS,
  sizeCommand: 'node scripts/count-slice.js',
};

describe('runSizeCommand (Story #5963)', () => {
  it('reads the last non-empty stdout line as the count, with no shell', async () => {
    assert.deepEqual(
      await runSizeCommand({
        command: 'node -e console.log(1);console.log(17);console.log()',
        env: process.env,
      }),
      { count: 17 },
    );
  });

  it('passes the caller env through to the command', async () => {
    assert.deepEqual(
      await runSizeCommand({
        command: 'node -e console.log(process.env.SLICE_COUNT)',
        env: { ...process.env, SLICE_COUNT: '42' },
      }),
      { count: 42 },
    );
  });

  it('reports a non-zero exit, unparseable output, a spawn error and a timeout', async () => {
    const env = process.env;
    assert.deepEqual(
      await runSizeCommand({ command: 'node -e process.exit(3)', env }),
      { reason: 'exited 3' },
    );
    assert.deepEqual(
      await runSizeCommand({ command: 'node -e console.log(typeof(1))', env }),
      { reason: 'printed no file count' },
    );
    const missing = await runSizeCommand({
      command: 'mandrel-no-such-sizer-5963',
      env,
    });
    assert.match(missing.reason, /^spawn failed/);
    assert.deepEqual(
      await runSizeCommand({
        command: 'node -e setTimeout(()=>{},10000)',
        env,
        timeoutMs: 100,
      }),
      { reason: 'timed out after 100ms' },
    );
  });
});

/** The weight `workload` books, and the log line, when sizing yields `sized`. */
async function booked(workload, sized) {
  const lines = [];
  const result = await sizeWorkload(workload, {
    log: (m) => lines.push(m),
    runSizeFn: async () => sized,
  });
  return { weight: result.weight, line: lines[0] };
}

describe('tier selection (Story #5963)', () => {
  it('takes the first tier, by ascending maxFiles, that covers the count', async () => {
    assert.equal((await booked(WORKLOAD, { count: 0 })).weight, 2);
    assert.equal((await booked(WORKLOAD, { count: 20 })).weight, 2);
    assert.equal((await booked(WORKLOAD, { count: 21 })).weight, 4);
    assert.equal((await booked(WORKLOAD, { count: 200 })).weight, 8);
  });

  it('books the full weight above every tier, on a failure, or for an oversized tier', async () => {
    const above = await booked(WORKLOAD, { count: 201 });
    assert.equal(above.weight, 8);
    assert.match(above.line, /full weight: no tier covers the slice/);
    const failed = await booked(WORKLOAD, { reason: 'exited 1' });
    assert.equal(failed.weight, 8);
    assert.match(failed.line, /unsized, full weight: exited 1/);
    const oversized = await booked(
      { ...WORKLOAD, weight: 4, tiers: [{ maxFiles: 10, weight: 6 }] },
      { count: 3 },
    );
    assert.equal(oversized.weight, 4);
    assert.match(
      oversized.line,
      /full weight: tier weight 6 exceeds the declared weight → weight 4 of 4/,
    );
  });
});

describe('sizeWorkload (Story #5963)', () => {
  it('re-weights a tiered workload and logs the slice and the choice', async () => {
    const lines = [];
    const calls = [];
    const sized = await sizeWorkload(WORKLOAD, {
      cwd: '/repo',
      env: { A: '1' },
      log: (m) => lines.push(m),
      runSizeFn: async (o) => {
        calls.push(o);
        return { count: 12 };
      },
    });
    assert.equal(sized.weight, 2);
    assert.equal(sized.declaredWeight, 8);
    assert.equal(sized.sliceFiles, 12);
    assert.deepEqual(calls, [
      { command: WORKLOAD.sizeCommand, cwd: '/repo', env: { A: '1' } },
    ]);
    assert.match(lines[0], /12 files → weight 2 of 8\.$/);
  });

  it('logs the fallback reason and books the full weight', async () => {
    const lines = [];
    const sized = await sizeWorkload(WORKLOAD, {
      log: (m) => lines.push(m),
      runSizeFn: async () => ({ reason: 'timed out after 60000ms' }),
    });
    assert.equal(sized.weight, 8);
    assert.equal(sized.sliceFiles, null);
    assert.match(lines[0], /unsized, full weight: timed out/);
  });

  it('leaves an untiered or non-declared workload untouched', async () => {
    const runSizeFn = async () => assert.fail('sizing must not run');
    const plain = { kind: 'declared', command: 'x', weight: 3, resources: [] };
    assert.equal(await sizeWorkload(plain, { log() {}, runSizeFn }), plain);
    const exclusive = { kind: 'exclusive' };
    assert.equal(
      await sizeWorkload(exclusive, { log() {}, runSizeFn }),
      exclusive,
    );
  });
});
