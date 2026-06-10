/**
 * bootstrap-infer-project-number.test — Story #3896.
 *
 * Covers `inferStoredProjectNumber`, the helper that surfaces an
 * already-provisioned project number from a project's `.agentrc.json` as the
 * `projectNumber` question default. Reading the stored number (rather than the
 * repo name) is prong (a) of the duplicate-board fix: an `--assume-yes` re-run
 * then resolves a *numeric* answer, which `detectCreation` classifies as an
 * existing project — so no second board is created (review Finding B.3).
 *
 * All I/O happens in a throw-away temp dir (unit tier; the function's own
 * filesystem boundary is the system under test).
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { inferStoredProjectNumber } from '../../.agents/scripts/lib/bootstrap/prompt.js';

const tmpDirs = [];

function makeTmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bootstrap-infer-pn-'));
  tmpDirs.push(dir);
  return dir;
}

function writeAgentrc(dir, config) {
  fs.writeFileSync(
    path.join(dir, '.agentrc.json'),
    `${JSON.stringify(config, null, 2)}\n`,
    'utf8',
  );
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    fs.rmSync(tmpDirs.pop(), { recursive: true, force: true });
  }
});

describe('inferStoredProjectNumber', () => {
  it('returns the stored github.projectNumber as a numeric string', () => {
    const dir = makeTmpDir();
    writeAgentrc(dir, { github: { owner: 'acme', projectNumber: 42 } });
    assert.equal(inferStoredProjectNumber(dir), '42');
  });

  it('returns null when no .agentrc.json exists', () => {
    const dir = makeTmpDir();
    assert.equal(inferStoredProjectNumber(dir), null);
  });

  it('returns null when the github block has no projectNumber', () => {
    const dir = makeTmpDir();
    writeAgentrc(dir, { github: { owner: 'acme' } });
    assert.equal(inferStoredProjectNumber(dir), null);
  });

  it('returns null when projectNumber is non-integer', () => {
    const dir = makeTmpDir();
    writeAgentrc(dir, { github: { projectNumber: 'Roadmap' } });
    assert.equal(inferStoredProjectNumber(dir), null);
  });

  it('returns null when the file is unparseable JSON', () => {
    const dir = makeTmpDir();
    fs.writeFileSync(path.join(dir, '.agentrc.json'), '{ not json', 'utf8');
    assert.equal(inferStoredProjectNumber(dir), null);
  });

  it('returns null for a blank/invalid projectRoot', () => {
    assert.equal(inferStoredProjectNumber(''), null);
    assert.equal(inferStoredProjectNumber(undefined), null);
  });
});
