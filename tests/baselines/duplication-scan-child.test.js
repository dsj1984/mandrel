import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { runDuplicationScan } from '../../.agents/scripts/lib/baselines/duplication-scan-fork.js';
import {
  resolveDetectClones,
  scanDuplication,
} from '../../.agents/scripts/lib/baselines/duplication-scanner.js';
import { resolveDefaultScorer } from '../../.agents/scripts/lib/baselines/refresh-service.js';
import { getAgentrcValidator } from '../../.agents/scripts/lib/config-schema.js';
import { makeTempDir } from '../../.agents/scripts/lib/test-temp.js';

function clonedSource() {
  return Array.from(
    { length: 6 },
    (_, i) =>
      `export function compute${i}(alpha, beta) {\n` +
      `  const total = alpha * beta + ${i};\n` +
      '  if (total > 100) { return total - alpha; }\n' +
      `  return total + beta * ${i};\n` +
      '}\n',
  ).join('\n');
}

/** A fake child that ends the way `finish` says once it has been sent work. */
function fakeFork(finish) {
  const calls = [];
  const forkImpl = (entry, args, options) => {
    const child = new EventEmitter();
    child.stderr = new EventEmitter();
    child.send = () => setImmediate(() => finish(child));
    calls.push({ entry, args, options });
    return child;
  };
  return { calls, forkImpl };
}

describe('runDuplicationScan — child lifecycle', () => {
  const scan = { targetDirs: ['src'], cwd: '/tree' };

  it('replaces the parent heap flag and keeps its other flags', async () => {
    const saved = process.execArgv;
    process.execArgv = ['--max-old-space-size=9000', '--require=/hook.cjs'];
    try {
      const { calls, forkImpl } = fakeFork((child) => {
        child.emit('message', { rows: [] });
        child.emit('close', 0, null);
      });
      await runDuplicationScan(scan, { scanHeapMb: 777, forkImpl });
      assert.deepEqual(calls[0].options.execArgv, [
        '--require=/hook.cjs',
        '--max-old-space-size=777',
      ]);
    } finally {
      process.execArgv = saved;
    }
  });

  it('forks with the configured heap flag and returns the rows', async () => {
    const rows = [{ path: 'src/a.js' }];
    const { calls, forkImpl } = fakeFork((child) => {
      child.emit('message', { rows });
      child.emit('close', 0, null);
    });
    assert.deepEqual(
      await runDuplicationScan(scan, { scanHeapMb: 777, forkImpl }),
      rows,
    );
    assert.equal(calls[0].options.execArgv.at(-1), '--max-old-space-size=777');
  });

  it('defaults the child heap to 4096 MB', async () => {
    const { calls, forkImpl } = fakeFork((child) => {
      child.emit('message', { rows: [] });
      child.emit('close', 0, null);
    });
    await runDuplicationScan(scan, { scanHeapMb: undefined, forkImpl });
    assert.equal(calls[0].options.execArgv.at(-1), '--max-old-space-size=4096');
  });

  it('names scanHeapMb when the child dies of heap exhaustion', async () => {
    for (const [code, signal, stderr] of [
      [null, 'SIGABRT', ''],
      [134, null, ''],
      [1, null, 'FATAL ERROR: JavaScript heap out of memory'],
    ]) {
      const { forkImpl } = fakeFork((child) => {
        child.stderr.emit('data', stderr);
        child.emit('close', code, signal);
      });
      await assert.rejects(
        runDuplicationScan(scan, { scanHeapMb: 512, forkImpl }),
        /512 MB.*scanHeapMb/,
      );
    }
  });

  it('reports any other death without blaming the heap', async () => {
    const { forkImpl } = fakeFork((child) => {
      child.stderr.emit('data', 'boom');
      child.emit('close', 3, null);
    });
    await assert.rejects(runDuplicationScan(scan, { forkImpl }), (err) => {
      assert.match(err.message, /exit code 3.*boom/);
      assert.doesNotMatch(err.message, /scanHeapMb/);
      return true;
    });
  });

  it('carries a child error code across the process boundary', async () => {
    const { forkImpl } = fakeFork((child) => {
      child.emit('message', {
        error: { message: 'npm i -D jscpd@^4', code: 'JSCPD_MISSING' },
      });
      child.emit('close', 0, null);
    });
    await assert.rejects(
      runDuplicationScan(scan, { forkImpl }),
      (err) =>
        err.code === 'JSCPD_MISSING' && err.message === 'npm i -D jscpd@^4',
    );
  });

  it('rejects when the child cannot be spawned', async () => {
    const spawnError = new Error('ENOENT');
    const { forkImpl } = fakeFork((child) => child.emit('error', spawnError));
    await assert.rejects(runDuplicationScan(scan, { forkImpl }), spawnError);
  });
});

describe('forked duplication scan — real jscpd', () => {
  let tree;

  beforeEach(() => {
    tree = realpathSync(makeTempDir('mandrel-dup-fork-'));
    mkdirSync(path.join(tree, 'src'), { recursive: true });
    writeFileSync(path.join(tree, 'src/a.js'), clonedSource());
    writeFileSync(path.join(tree, 'src/b.js'), clonedSource());
  });

  afterEach(() => {
    rmSync(tree, { recursive: true, force: true });
  });

  it('returns the rows an in-process scan returns, partners included', async () => {
    const scan = { targetDirs: ['src'], cwd: tree };
    const forked = await runDuplicationScan(scan, { scanHeapMb: 512 });
    const inProcess = await scanDuplication({
      ...scan,
      detect: resolveDetectClones(),
    });
    assert.ok(forked.length > 0, 'the fixture must hold clones');
    assert.ok(forked.every((row) => row.partners.length > 0));
    assert.deepEqual(forked, inProcess);
  });

  it('an unknown format fails the scan with its refusal', async () => {
    await assert.rejects(
      runDuplicationScan({
        targetDirs: ['src'],
        cwd: tree,
        additionalFormats: ['not-a-format'],
      }),
      /unknown jscpd format/,
    );
  });

  it('an injected detect scans in-process', async () => {
    let handed;
    const scorer = resolveDefaultScorer('duplication', {
      cwd: tree,
      detect: async (opts) => {
        handed = opts;
        return [];
      },
    });
    assert.deepEqual(await scorer([], { cwd: tree }), []);
    assert.equal(handed.cwd, tree);
  });
});

describe('scanHeapMb config', () => {
  const accepts = (scanHeapMb) =>
    getAgentrcValidator()({
      project: {
        paths: { agentRoot: '.agents', docsRoot: 'docs', tempRoot: 'temp' },
      },
      delivery: { quality: { gates: { duplication: { scanHeapMb } } } },
    });

  it('accepts an integer of at least 256 and rejects anything else', () => {
    assert.equal(accepts(256), true);
    assert.equal(accepts(8192), true);
    assert.equal(accepts(255), false);
    assert.equal(accepts(1024.5), false);
  });
});
