import assert from 'node:assert/strict';
import fs from 'node:fs';
import { rm as fsPromisesRm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  computeProtectedPids,
  fetchProcessTable,
  findHoldersInPath,
  forceDrainPendingCleanup,
  terminateHolders,
} from '../../../.agents/scripts/lib/worktree/lifecycle/force-drain.js';
import {
  manifestPath,
  readManifest,
  recordPendingCleanup,
} from '../../../.agents/scripts/lib/worktree/lifecycle/pending-cleanup.js';

function quietLogger() {
  const sink = { info: [], warn: [], error: [] };
  return {
    sink,
    logger: {
      info: (m) => sink.info.push(m),
      warn: (m) => sink.warn.push(m),
      error: (m) => sink.error.push(m),
    },
  };
}

function tmpWorktreeRoot() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fd-'));
  const wtRoot = path.join(tmp, '.worktrees');
  fs.mkdirSync(wtRoot, { recursive: true });
  return { tmp, wtRoot };
}

function fakePsSpawn({ stdout = '', status = 0, stderr = '' } = {}) {
  return () => ({ stdout, status, stderr });
}

// ---- findHoldersInPath ----

test('findHoldersInPath: non-Windows returns []', () => {
  const got = findHoldersInPath('/some/wt', { platform: 'linux' });
  assert.deepEqual(got, []);
});

test('findHoldersInPath: empty path returns []', () => {
  const got = findHoldersInPath('', { platform: 'win32' });
  assert.deepEqual(got, []);
});

test('findHoldersInPath: parses single-object PowerShell output', () => {
  const stdout = JSON.stringify({
    ProcessId: 1234,
    Name: 'node.exe',
    ExecutablePath: 'C:\\\\repo\\\\.worktrees\\\\story-99\\\\node.exe',
    CommandLine: 'node script.js',
  });
  const got = findHoldersInPath('C:\\repo\\.worktrees\\story-99', {
    platform: 'win32',
    spawn: fakePsSpawn({ stdout }),
  });
  assert.equal(got.length, 1);
  assert.equal(got[0].pid, 1234);
  assert.equal(got[0].name, 'node.exe');
});

test('findHoldersInPath: parses array PowerShell output', () => {
  const stdout = JSON.stringify([
    { ProcessId: 1, Name: 'a.exe', ExecutablePath: 'x', CommandLine: 'y' },
    { ProcessId: 2, Name: 'b.exe', ExecutablePath: 'x', CommandLine: 'y' },
  ]);
  const got = findHoldersInPath('C:\\wt', {
    platform: 'win32',
    spawn: fakePsSpawn({ stdout }),
  });
  assert.deepEqual(
    got.map((h) => h.pid),
    [1, 2],
  );
});

test('findHoldersInPath: PowerShell non-zero exit returns []', () => {
  const got = findHoldersInPath('C:\\wt', {
    platform: 'win32',
    spawn: fakePsSpawn({ status: 1, stderr: 'boom' }),
  });
  assert.deepEqual(got, []);
});

test('findHoldersInPath: bad JSON returns []', () => {
  const got = findHoldersInPath('C:\\wt', {
    platform: 'win32',
    spawn: fakePsSpawn({ stdout: 'not json' }),
  });
  assert.deepEqual(got, []);
});

test('findHoldersInPath: drops entries without numeric ProcessId', () => {
  const stdout = JSON.stringify([
    { ProcessId: 0, Name: 'idle.exe' },
    { ProcessId: 'not a number', Name: 'weird' },
    { ProcessId: 42, Name: 'ok.exe' },
  ]);
  const got = findHoldersInPath('C:\\wt', {
    platform: 'win32',
    spawn: fakePsSpawn({ stdout }),
  });
  assert.equal(got.length, 1);
  assert.equal(got[0].pid, 42);
});

// ---- terminateHolders ----

test('terminateHolders: non-Windows returns []', () => {
  const got = terminateHolders([{ pid: 1, name: 'x' }], { platform: 'linux' });
  assert.deepEqual(got, []);
});

test('terminateHolders: empty list returns []', () => {
  const got = terminateHolders([], { platform: 'win32' });
  assert.deepEqual(got, []);
});

test('terminateHolders: collects pids whose taskkill exits 0', () => {
  const calls = [];
  const spawn = (cmd, args) => {
    // ancestry table fetch (Story #4018) — no rows means only self is protected
    if (cmd === 'powershell.exe') return { status: 0, stdout: '', stderr: '' };
    calls.push({ cmd, args });
    const pid = Number.parseInt(args[args.indexOf('/PID') + 1], 10);
    return { status: pid === 99 ? 1 : 0, stdout: '', stderr: 'no such pid' };
  };
  const { logger, sink } = quietLogger();
  const got = terminateHolders(
    [
      { pid: 11, name: 'node.exe' },
      { pid: 99, name: 'gone.exe' },
      { pid: 22, name: 'tsc.exe' },
    ],
    { platform: 'win32', spawn, logger },
  );
  assert.deepEqual(got, [11, 22]);
  assert.equal(calls.length, 3);
  assert.ok(sink.warn.some((m) => m.includes('terminated pid=11')));
  assert.ok(sink.warn.some((m) => m.includes('taskkill pid=99 failed')));
});

// ---- forceDrainPendingCleanup ----

test('forceDrainPendingCleanup: empty manifest returns standard shape + empty escalation fields', async () => {
  const { tmp, wtRoot } = tmpWorktreeRoot();
  try {
    const res = await forceDrainPendingCleanup({
      repoRoot: tmp,
      worktreeRoot: wtRoot,
      git: { gitSpawn: () => ({ status: 0, stdout: '', stderr: '' }) },
      fsRm: async () => {},
      logger: quietLogger().logger,
      findHolders: () => {
        throw new Error('should not be called');
      },
      killHolders: () => {
        throw new Error('should not be called');
      },
    });
    assert.deepEqual(res.drained, []);
    assert.deepEqual(res.escalated, []);
    assert.deepEqual(res.killedPids, {});
    assert.deepEqual(res.noHolders, []);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('forceDrainPendingCleanup: passes through when standard drain succeeds', async () => {
  const { tmp, wtRoot } = tmpWorktreeRoot();
  try {
    const wtPath = path.join(wtRoot, 'story-7');
    fs.mkdirSync(wtPath, { recursive: true });
    recordPendingCleanup(wtRoot, {
      storyId: 7,
      branch: 'story-7',
      path: wtPath,
    });
    const res = await forceDrainPendingCleanup({
      repoRoot: tmp,
      worktreeRoot: wtRoot,
      git: { gitSpawn: () => ({ status: 0, stdout: '', stderr: '' }) },
      fsRm: fsPromisesRm,
      logger: quietLogger().logger,
      findHolders: () => {
        throw new Error('escalation must not run when first drain clears it');
      },
      killHolders: () => [],
    });
    assert.deepEqual(res.drained, [7]);
    assert.deepEqual(res.escalated, []);
    assert.deepEqual(res.killedPids, {});
    assert.equal(fs.existsSync(manifestPath(wtRoot)), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('forceDrainPendingCleanup: escalates when standard drain leaves entries stuck and lock clears after kill', async () => {
  const { tmp, wtRoot } = tmpWorktreeRoot();
  try {
    const wtPath = path.join(wtRoot, 'story-405');
    fs.mkdirSync(wtPath, { recursive: true });
    recordPendingCleanup(wtRoot, {
      storyId: 405,
      branch: 'story-405',
      path: wtPath,
    });

    // fsRm fails the first time (initial drain), succeeds the second time
    // (after escalation).
    let callCount = 0;
    const fsRm = async (p, opts) => {
      callCount += 1;
      if (callCount === 1) {
        const e = new Error('EBUSY');
        e.code = 'EBUSY';
        throw e;
      }
      await fsPromisesRm(p, opts);
    };

    const findHolders = (p) => {
      assert.equal(p, wtPath);
      return [
        {
          pid: 4242,
          name: 'node.exe',
          path: 'C:\\\\.worktrees\\\\story-405\\\\node.exe',
        },
      ];
    };
    const killCalls = [];
    const killHolders = (holders) => {
      killCalls.push(holders.map((h) => h.pid));
      return holders.map((h) => h.pid);
    };

    const { logger, sink } = quietLogger();
    const res = await forceDrainPendingCleanup({
      repoRoot: tmp,
      worktreeRoot: wtRoot,
      git: { gitSpawn: () => ({ status: 0, stdout: '', stderr: '' }) },
      fsRm,
      logger,
      findHolders,
      killHolders,
      sleep: async () => {}, // no real wait in tests
    });
    assert.deepEqual(res.drained, [405]);
    assert.deepEqual(res.escalated, [405]);
    assert.deepEqual(res.killedPids, { 405: [4242] });
    assert.deepEqual(killCalls, [[4242]]);
    assert.equal(readManifest(wtRoot).length, 0);
    assert.ok(
      sink.warn.some((m) => m.includes('escalating storyId=405')),
      'expected escalation log line',
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('forceDrainPendingCleanup: records noHolders when find returns empty (kernel-held)', async () => {
  const { tmp, wtRoot } = tmpWorktreeRoot();
  try {
    const wtPath = path.join(wtRoot, 'story-372');
    fs.mkdirSync(wtPath, { recursive: true });
    recordPendingCleanup(wtRoot, {
      storyId: 372,
      branch: 'story-372',
      path: wtPath,
    });
    const fsRm = async () => {
      const e = new Error('EBUSY');
      e.code = 'EBUSY';
      throw e;
    };
    const { logger, sink } = quietLogger();
    const res = await forceDrainPendingCleanup({
      repoRoot: tmp,
      worktreeRoot: wtRoot,
      git: { gitSpawn: () => ({ status: 0, stdout: '', stderr: '' }) },
      fsRm,
      logger,
      findHolders: () => [],
      killHolders: () => {
        throw new Error('should not be called when no holders found');
      },
      sleep: async () => {},
    });
    assert.deepEqual(res.drained, []);
    assert.deepEqual(res.escalated, []);
    assert.deepEqual(res.noHolders, [372]);
    assert.ok(
      sink.warn.some((m) => m.includes('no user-mode holders')),
      'expected kernel-held warning',
    );
    // Entry remains in manifest for the next sweep.
    assert.equal(readManifest(wtRoot).length, 1);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('forceDrainPendingCleanup: escalate=false skips the kill phase entirely', async () => {
  const { tmp, wtRoot } = tmpWorktreeRoot();
  try {
    const wtPath = path.join(wtRoot, 'story-8');
    fs.mkdirSync(wtPath, { recursive: true });
    recordPendingCleanup(wtRoot, {
      storyId: 8,
      branch: 'story-8',
      path: wtPath,
    });
    const fsRm = async () => {
      throw new Error('EBUSY');
    };
    const res = await forceDrainPendingCleanup({
      repoRoot: tmp,
      worktreeRoot: wtRoot,
      git: { gitSpawn: () => ({ status: 0, stdout: '', stderr: '' }) },
      fsRm,
      logger: quietLogger().logger,
      findHolders: () => {
        throw new Error('escalate=false must skip findHolders');
      },
      killHolders: () => [],
      escalate: false,
    });
    assert.deepEqual(res.drained, []);
    assert.deepEqual(res.escalated, []);
    assert.deepEqual(res.killedPids, {});
    assert.deepEqual(res.noHolders, []);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('forceDrainPendingCleanup: escalation that fails to kill leaves entry in manifest', async () => {
  const { tmp, wtRoot } = tmpWorktreeRoot();
  try {
    const wtPath = path.join(wtRoot, 'story-99');
    fs.mkdirSync(wtPath, { recursive: true });
    recordPendingCleanup(wtRoot, {
      storyId: 99,
      branch: 'story-99',
      path: wtPath,
    });
    const fsRm = async () => {
      const e = new Error('EBUSY');
      e.code = 'EBUSY';
      throw e;
    };
    const res = await forceDrainPendingCleanup({
      repoRoot: tmp,
      worktreeRoot: wtRoot,
      git: { gitSpawn: () => ({ status: 0, stdout: '', stderr: '' }) },
      fsRm,
      logger: quietLogger().logger,
      findHolders: () => [{ pid: 1, name: 'x.exe' }],
      killHolders: () => [], // taskkill failed for every pid
      sleep: async () => {},
    });
    assert.deepEqual(res.drained, []);
    assert.deepEqual(res.escalated, []);
    assert.equal(readManifest(wtRoot).length, 1);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ---- self/ancestor kill-set protection (Story #4018) ----

test('computeProtectedPids: includes self and full ancestor chain', () => {
  // synthetic table: 500 (shell) -> 400 (orchestrator) -> 300 (self); 999 unrelated
  const table = [
    { pid: 300, ppid: 400 },
    { pid: 400, ppid: 500 },
    { pid: 500, ppid: 1 },
    { pid: 999, ppid: 1 },
  ];
  const got = computeProtectedPids(300, table);
  assert.deepEqual(
    [...got].sort((a, b) => a - b),
    [1, 300, 400, 500],
  );
  assert.equal(got.has(999), false);
});

test('computeProtectedPids: empty table still protects self', () => {
  assert.deepEqual([...computeProtectedPids(42, [])], [42]);
});

test('computeProtectedPids: cycle-guarded against corrupt tables', () => {
  const table = [
    { pid: 10, ppid: 20 },
    { pid: 20, ppid: 10 },
  ];
  const got = computeProtectedPids(10, table);
  assert.deepEqual(
    [...got].sort((a, b) => a - b),
    [10, 20],
  );
});

test('fetchProcessTable: non-Windows returns []', () => {
  assert.deepEqual(fetchProcessTable({ platform: 'linux' }), []);
});

test('fetchProcessTable: parses pid/ppid rows, tolerates failure', () => {
  const stdout = JSON.stringify([
    { ProcessId: 1, ParentProcessId: 0 },
    { ProcessId: 2, ParentProcessId: 1 },
  ]);
  assert.deepEqual(
    fetchProcessTable({ platform: 'win32', spawn: fakePsSpawn({ stdout }) }),
    [
      { pid: 1, ppid: 0 },
      { pid: 2, ppid: 1 },
    ],
  );
  assert.deepEqual(
    fetchProcessTable({ platform: 'win32', spawn: fakePsSpawn({ status: 1 }) }),
    [],
  );
});

test('terminateHolders: never taskkills self or ancestors (synthetic process table)', () => {
  const { logger, sink } = quietLogger();
  const taskkilled = [];
  // Process tree: 500 (ancestor shell) -> 400 -> 300 (self). 777 is a real holder.
  const table = [
    { pid: 300, ppid: 400 },
    { pid: 400, ppid: 500 },
    { pid: 500, ppid: 4 },
    { pid: 777, ppid: 4 },
  ];
  const spawn = (cmd, args) => {
    if (cmd === 'powershell.exe') {
      return {
        status: 0,
        stdout: JSON.stringify(
          table.map((r) => ({ ProcessId: r.pid, ParentProcessId: r.ppid })),
        ),
      };
    }
    taskkilled.push(args[args.indexOf('/PID') + 1]);
    return { status: 0, stdout: '', stderr: '' };
  };
  const holders = [
    { pid: 300, name: 'node.exe' }, // self
    { pid: 400, name: 'pwsh.exe' }, // parent
    { pid: 500, name: 'cmd.exe' }, // grandparent
    { pid: 777, name: 'holder.exe' }, // genuine holder
  ];
  const killed = terminateHolders(holders, {
    platform: 'win32',
    spawn,
    logger,
    selfPid: 300,
  });
  assert.deepEqual(killed, [777]);
  assert.deepEqual(taskkilled, ['777']);
  assert.equal(sink.warn.filter((m) => m.includes('self/ancestor')).length, 3);
});

test('terminateHolders: explicit protectedPids set is honored without a table fetch', () => {
  const { logger } = quietLogger();
  const calls = [];
  const spawn = (cmd) => {
    calls.push(cmd);
    return { status: 0, stdout: '', stderr: '' };
  };
  const killed = terminateHolders([{ pid: 9, name: 'x.exe' }], {
    platform: 'win32',
    spawn,
    logger,
    protectedPids: new Set([9]),
  });
  assert.deepEqual(killed, []);
  assert.deepEqual(calls, []); // no powershell table fetch, no taskkill
});
