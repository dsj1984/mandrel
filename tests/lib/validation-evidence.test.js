import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import {
  evidencePath,
  forceClear,
  hashCommandConfig,
  loadEvidence,
  recordPass,
  SCHEMA_VERSION,
  shouldSkip,
} from '../../.agents/scripts/lib/validation-evidence.js';

/**
 * Minimal in-memory fs adapter compatible with the synchronous surface that
 * validation-evidence.js consumes. Keeps tests independent from any real
 * temp/ directory and side-effect free.
 */
function makeFakeFs() {
  const files = new Map();
  return {
    files,
    existsSync: (p) => files.has(path.resolve(p)),
    mkdirSync: () => {},
    readFileSync: (p) => {
      const v = files.get(path.resolve(p));
      if (v == null) {
        const err = new Error(`ENOENT: ${p}`);
        err.code = 'ENOENT';
        throw err;
      }
      return v;
    },
    unlinkSync: (p) => {
      files.delete(path.resolve(p));
    },
    writeFileSync: (p, data) => {
      files.set(path.resolve(p), String(data));
    },
  };
}

const FIXED_NOW = new Date('2026-04-25T20:00:00Z');
const fixedNow = () => FIXED_NOW;
const FAKE_CWD = path.resolve('/fake-worktree');
const FAKE_EPIC_ID = 802;

function baseOpts(extra = {}) {
  const fs = extra.fs ?? makeFakeFs();
  const { fs: _ignore, ...rest } = extra;
  return {
    cwd: FAKE_CWD,
    now: fixedNow,
    epicId: FAKE_EPIC_ID,
    ...rest,
    fs,
  };
}

test('evidencePath() resolves a Story-scoped path under temp/epic-<eid>/stories/story-<sid>/', () => {
  const expected = path.join(
    FAKE_CWD,
    'temp',
    'epic-802',
    'stories',
    'story-901',
    'validation-evidence.json',
  );
  assert.equal(
    evidencePath(901, { cwd: FAKE_CWD, epicId: FAKE_EPIC_ID }),
    expected,
  );
});

test('evidencePath() resolves an Epic-scoped path when scopeId === epicId', () => {
  const expected = path.join(
    FAKE_CWD,
    'temp',
    'epic-802',
    'validation-evidence.json',
  );
  assert.equal(
    evidencePath(FAKE_EPIC_ID, { cwd: FAKE_CWD, epicId: FAKE_EPIC_ID }),
    expected,
  );
});

test('evidencePath() throws when epicId is missing', () => {
  assert.throws(
    () => evidencePath(901, { cwd: FAKE_CWD }),
    /requires opts\.epicId/,
  );
});

test('hashCommandConfig() is deterministic and shape-valid', () => {
  const a = hashCommandConfig({ cmd: 'npm', args: ['run', 'lint'], cwd: '/x' });
  const b = hashCommandConfig({ cmd: 'npm', args: ['run', 'lint'], cwd: '/x' });
  assert.equal(a, b);
  assert.match(a, /^sha256:[0-9a-f]{64}$/);
});

test('hashCommandConfig() differs when any input differs', () => {
  const base = hashCommandConfig({ cmd: 'npm', args: ['run', 'lint'] });
  assert.notEqual(
    base,
    hashCommandConfig({ cmd: 'npm', args: ['run', 'test'] }),
  );
  assert.notEqual(
    base,
    hashCommandConfig({ cmd: 'pnpm', args: ['run', 'lint'] }),
  );
  assert.notEqual(
    base,
    hashCommandConfig({ cmd: 'npm', args: ['run', 'lint'], cwd: '/y' }),
  );
});

test('hashCommandConfig() throws on missing cmd', () => {
  assert.throws(() => hashCommandConfig({ args: ['x'] }), /non-empty `cmd`/);
});

test('loadEvidence() returns an empty doc when no file exists', () => {
  const opts = baseOpts();
  const doc = loadEvidence(901, opts);
  assert.deepEqual(doc, {
    storyId: 901,
    schemaVersion: SCHEMA_VERSION,
    records: [],
  });
});

test('recordPass() persists a record and round-trips via loadEvidence()', () => {
  const opts = baseOpts();
  const configHash = hashCommandConfig({
    cmd: 'npm',
    args: ['run', 'lint'],
    cwd: FAKE_CWD,
  });
  const record = recordPass(
    {
      storyId: 901,
      gateName: 'lint',
      sha: 'abc1234',
      configHash,
      exitCode: 0,
      durationMs: 12450,
    },
    opts,
  );
  assert.equal(record.gateName, 'lint');
  assert.equal(record.commitSha, 'abc1234');
  assert.equal(record.commandConfigHash, configHash);
  assert.equal(record.exitCode, 0);
  assert.equal(record.durationMs, 12450);
  assert.equal(record.timestamp, FIXED_NOW.toISOString());

  const loaded = loadEvidence(901, opts);
  assert.equal(loaded.records.length, 1);
  assert.deepEqual(loaded.records[0], record);
});

test('recordPass() replaces a prior record for the same gateName', () => {
  const opts = baseOpts();
  const cfg = hashCommandConfig({ cmd: 'npm', args: ['run', 'lint'] });
  recordPass(
    { storyId: 901, gateName: 'lint', sha: 'aaaaaaa', configHash: cfg },
    opts,
  );
  recordPass(
    { storyId: 901, gateName: 'lint', sha: 'bbbbbbb', configHash: cfg },
    opts,
  );
  const doc = loadEvidence(901, opts);
  assert.equal(doc.records.length, 1);
  assert.equal(doc.records[0].commitSha, 'bbbbbbb');
});

test('recordPass() preserves records for sibling gates', () => {
  const opts = baseOpts();
  const cfg = hashCommandConfig({ cmd: 'npm', args: ['run', 'lint'] });
  recordPass(
    { storyId: 901, gateName: 'lint', sha: '1111111', configHash: cfg },
    opts,
  );
  recordPass(
    {
      storyId: 901,
      gateName: 'test',
      sha: '1111111',
      configHash: hashCommandConfig({ cmd: 'npm', args: ['test'] }),
    },
    opts,
  );
  const doc = loadEvidence(901, opts);
  assert.equal(doc.records.length, 2);
  assert.deepEqual(doc.records.map((r) => r.gateName).sort(), ['lint', 'test']);
});

test('recordPass() throws when required input is missing', () => {
  assert.throws(
    () => recordPass({ gateName: 'lint', sha: 'x', configHash: 'sha256:y' }),
    /requires/,
  );
});

test('shouldSkip() returns no-record when nothing has been recorded', () => {
  const opts = baseOpts();
  const cfg = hashCommandConfig({ cmd: 'npm', args: ['run', 'lint'] });
  assert.deepEqual(
    shouldSkip(
      {
        storyId: 901,
        gateName: 'lint',
        currentSha: 'abcdef0',
        configHash: cfg,
      },
      opts,
    ),
    { skip: false, reason: 'no-record' },
  );
});

test('shouldSkip() grants skip on full triple-match (gate + SHA + config)', () => {
  const opts = baseOpts();
  const cfg = hashCommandConfig({ cmd: 'npm', args: ['run', 'lint'] });
  recordPass(
    { storyId: 901, gateName: 'lint', sha: 'abcdef0', configHash: cfg },
    opts,
  );
  const result = shouldSkip(
    { storyId: 901, gateName: 'lint', currentSha: 'abcdef0', configHash: cfg },
    opts,
  );
  assert.equal(result.skip, true);
  assert.equal(result.reason, 'evidence-match');
  assert.equal(result.record.commitSha, 'abcdef0');
});

test('shouldSkip() refuses skip on SHA mismatch (HEAD moved)', () => {
  const opts = baseOpts();
  const cfg = hashCommandConfig({ cmd: 'npm', args: ['run', 'lint'] });
  recordPass(
    { storyId: 901, gateName: 'lint', sha: '1234abc', configHash: cfg },
    opts,
  );
  const result = shouldSkip(
    {
      storyId: 901,
      gateName: 'lint',
      currentSha: '5678def',
      configHash: cfg,
    },
    opts,
  );
  assert.equal(result.skip, false);
  assert.equal(result.reason, 'sha-mismatch');
});

test('shouldSkip() refuses skip on command-config-hash mismatch', () => {
  const opts = baseOpts();
  const oldCfg = hashCommandConfig({ cmd: 'npm', args: ['run', 'lint'] });
  const newCfg = hashCommandConfig({
    cmd: 'npm',
    args: ['run', 'lint', '--', '--max-warnings=0'],
  });
  recordPass(
    { storyId: 901, gateName: 'lint', sha: 'abcdef0', configHash: oldCfg },
    opts,
  );
  const result = shouldSkip(
    {
      storyId: 901,
      gateName: 'lint',
      currentSha: 'abcdef0',
      configHash: newCfg,
    },
    opts,
  );
  assert.equal(result.skip, false);
  assert.equal(result.reason, 'config-hash-mismatch');
});

test('shouldSkip() returns missing-input when any field is empty', () => {
  const opts = baseOpts();
  assert.equal(
    shouldSkip(
      {
        storyId: 901,
        gateName: 'lint',
        currentSha: '',
        configHash: 'sha256:x',
      },
      opts,
    ).skip,
    false,
  );
  assert.equal(
    shouldSkip(
      {
        storyId: 901,
        gateName: '',
        currentSha: 'abcdef0',
        configHash: 'sha256:x',
      },
      opts,
    ).reason,
    'missing-input',
  );
});

test('forceClear() removes the evidence file when present', () => {
  const opts = baseOpts();
  const cfg = hashCommandConfig({ cmd: 'npm', args: ['run', 'lint'] });
  recordPass(
    { storyId: 901, gateName: 'lint', sha: 'abcdef0', configHash: cfg },
    opts,
  );
  const cleared = forceClear(901, opts);
  assert.equal(cleared.cleared, true);
  assert.equal(loadEvidence(901, opts).records.length, 0);
});

test('forceClear() is a no-op when no evidence file exists', () => {
  const opts = baseOpts();
  const result = forceClear(901, opts);
  assert.equal(result.cleared, false);
});

test('loadEvidence() ignores a corrupt JSON file', () => {
  const fs = makeFakeFs();
  const file = evidencePath(901, { cwd: FAKE_CWD, epicId: FAKE_EPIC_ID });
  fs.writeFileSync(file, 'not-json{{{');
  const doc = loadEvidence(901, { cwd: FAKE_CWD, epicId: FAKE_EPIC_ID, fs });
  assert.deepEqual(doc.records, []);
});

test('loadEvidence() ignores a file whose storyId disagrees with the path', () => {
  const fs = makeFakeFs();
  const file = evidencePath(901, { cwd: FAKE_CWD, epicId: FAKE_EPIC_ID });
  fs.writeFileSync(
    file,
    JSON.stringify({ storyId: 902, schemaVersion: 1, records: [] }),
  );
  const doc = loadEvidence(901, { cwd: FAKE_CWD, epicId: FAKE_EPIC_ID, fs });
  assert.deepEqual(doc.records, []);
});

test('loadEvidence() ignores a file whose schemaVersion does not match', () => {
  const fs = makeFakeFs();
  const file = evidencePath(901, { cwd: FAKE_CWD, epicId: FAKE_EPIC_ID });
  fs.writeFileSync(
    file,
    JSON.stringify({ storyId: 901, schemaVersion: 999, records: [] }),
  );
  const doc = loadEvidence(901, { cwd: FAKE_CWD, epicId: FAKE_EPIC_ID, fs });
  assert.deepEqual(doc.records, []);
});

test('shouldSkip() grants skip on inputFingerprint when SHA differs but inputs are byte-identical', () => {
  const fs = makeFakeFs();
  const opts = baseOpts({ fs });
  const configHash = hashCommandConfig({
    cmd: 'fake-lint',
    args: ['--no-cache'],
    cwd: FAKE_CWD,
  });

  // Record a pass against an old SHA, with an input fingerprint over the
  // gate's effective inputs.
  recordPass(
    {
      storyId: 901,
      gateName: 'lint',
      sha: 'a1b2c3d4e5f60000',
      configHash,
      inputFingerprint: 'sha256:beef',
    },
    opts,
  );

  // SHA has moved (e.g. a docs-only commit) but the gate's inputs hashed to
  // the same fingerprint — skip should fire on the fingerprint.
  const verdict = shouldSkip(
    {
      storyId: 901,
      gateName: 'lint',
      currentSha: '9a8b7c6d5e4f0000',
      configHash,
      inputFingerprint: 'sha256:beef',
    },
    opts,
  );
  assert.equal(verdict.skip, true);
  assert.equal(verdict.reason, 'fingerprint-match');
  assert.equal(verdict.record.commitSha, 'a1b2c3d4e5f60000');

  // Different fingerprint → no skip (inputs actually changed).
  const noSkip = shouldSkip(
    {
      storyId: 901,
      gateName: 'lint',
      currentSha: '9a8b7c6d5e4f0000',
      configHash,
      inputFingerprint: 'sha256:cafe',
    },
    opts,
  );
  assert.equal(noSkip.skip, false);
  assert.equal(noSkip.reason, 'sha-mismatch');

  // No fingerprint supplied → falls back to legacy SHA-mismatch behaviour.
  const legacyMiss = shouldSkip(
    {
      storyId: 901,
      gateName: 'lint',
      currentSha: '9a8b7c6d5e4f0000',
      configHash,
    },
    opts,
  );
  assert.equal(legacyMiss.skip, false);
  assert.equal(legacyMiss.reason, 'sha-mismatch');

  // configHash mismatch must always lose, regardless of fingerprint.
  const configMiss = shouldSkip(
    {
      storyId: 901,
      gateName: 'lint',
      currentSha: 'a1b2c3d4e5f60000',
      configHash: hashCommandConfig({
        cmd: 'fake-lint',
        args: ['--cache'],
        cwd: FAKE_CWD,
      }),
      inputFingerprint: 'sha256:beef',
    },
    opts,
  );
  assert.equal(configMiss.skip, false);
  assert.equal(configMiss.reason, 'config-hash-mismatch');
});
