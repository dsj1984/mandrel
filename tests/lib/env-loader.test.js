import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { loadEnv } from '../../.agents/scripts/lib/env-loader.js';
import { Logger } from '../../.agents/scripts/lib/Logger.js';

describe('loadEnv', () => {
  let tmpDir;
  const testKeys = [];

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-loader-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    // Clean up any env vars we set
    for (const key of testKeys) {
      delete process.env[key];
    }
    testKeys.length = 0;
  });

  function track(key) {
    testKeys.push(key);
  }

  it('loads simple KEY=VALUE pairs', () => {
    track('TEST_SIMPLE_KEY');
    fs.writeFileSync(path.join(tmpDir, '.env'), 'TEST_SIMPLE_KEY=hello\n');
    loadEnv(tmpDir);
    assert.strictEqual(process.env.TEST_SIMPLE_KEY, 'hello');
  });

  it('strips double quotes from values', () => {
    track('TEST_DQ_KEY');
    fs.writeFileSync(path.join(tmpDir, '.env'), 'TEST_DQ_KEY="quoted value"\n');
    loadEnv(tmpDir);
    assert.strictEqual(process.env.TEST_DQ_KEY, 'quoted value');
  });

  it('strips single quotes from values', () => {
    track('TEST_SQ_KEY');
    fs.writeFileSync(
      path.join(tmpDir, '.env'),
      "TEST_SQ_KEY='single quoted'\n",
    );
    loadEnv(tmpDir);
    assert.strictEqual(process.env.TEST_SQ_KEY, 'single quoted');
  });

  it('handles empty values', () => {
    track('TEST_EMPTY_KEY');
    fs.writeFileSync(path.join(tmpDir, '.env'), 'TEST_EMPTY_KEY=\n');
    loadEnv(tmpDir);
    assert.strictEqual(process.env.TEST_EMPTY_KEY, '');
  });

  it('ignores blank lines and comments', () => {
    track('TEST_AFTER_BLANK');
    fs.writeFileSync(
      path.join(tmpDir, '.env'),
      '\n# comment\n\nTEST_AFTER_BLANK=yes\n',
    );
    loadEnv(tmpDir);
    assert.strictEqual(process.env.TEST_AFTER_BLANK, 'yes');
  });

  it('does nothing when .env is missing', () => {
    // No .env file in tmpDir
    assert.doesNotThrow(() => loadEnv(tmpDir));
  });

  it('loads multiple keys', () => {
    track('TEST_A');
    track('TEST_B');
    fs.writeFileSync(path.join(tmpDir, '.env'), 'TEST_A=1\nTEST_B=2\n');
    loadEnv(tmpDir);
    assert.strictEqual(process.env.TEST_A, '1');
    assert.strictEqual(process.env.TEST_B, '2');
  });

  it('stays silent when .env read fails with ENOENT', (t) => {
    fs.writeFileSync(path.join(tmpDir, '.env'), 'TEST_KEY=1\n');

    const enoent = new Error('ENOENT: no such file or directory');
    enoent.code = 'ENOENT';
    t.mock.method(fs, 'readFileSync', () => {
      throw enoent;
    });
    const warnMock = t.mock.method(Logger, 'warn', () => {});

    assert.doesNotThrow(() => loadEnv(tmpDir));
    assert.strictEqual(
      warnMock.mock.callCount(),
      0,
      'ENOENT is the silent case and MUST NOT warn',
    );
  });

  it('warns with path and error code on a non-ENOENT read error', (t) => {
    fs.writeFileSync(path.join(tmpDir, '.env'), 'TEST_KEY=1\n');

    const eacces = new Error('EACCES: permission denied');
    eacces.code = 'EACCES';
    t.mock.method(fs, 'readFileSync', () => {
      throw eacces;
    });
    const warnMock = t.mock.method(Logger, 'warn', () => {});

    assert.doesNotThrow(() => loadEnv(tmpDir));
    assert.strictEqual(warnMock.mock.callCount(), 1);
    const [message] = warnMock.mock.calls[0].arguments;
    assert.match(message, /env-loader/);
    assert.match(message, /\.env/);
    assert.match(message, /EACCES/);
  });
});
