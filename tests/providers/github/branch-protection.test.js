/**
 * Unit tests for `.agents/scripts/providers/github/branch-protection.js`.
 *
 * Covers the GET (`enabled` boolean + raw merge) path, the 404 → disabled
 * short-circuit, and the additive PUT (context merge, override-precedence
 * logic) behaviour.
 *
 * Story #2462 / Task #2478 — BranchProtectionGateway is the fifth slice
 * of the seven-gateway split.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..', '..');

const bpMod = await import(
  pathToFileURL(
    path.join(
      ROOT,
      '.agents',
      'scripts',
      'providers',
      'github',
      'branch-protection.js',
    ),
  ).href
);
const ghExecMod = await import(
  pathToFileURL(path.join(ROOT, '.agents', 'scripts', 'lib', 'gh-exec.js')).href
);

const { BranchProtectionGateway, isNotFoundError } = bpMod;
const { createGh } = ghExecMod;

function makeFakeGh(routes) {
  const calls = [];
  const exec = async ({ args, input }) => {
    calls.push({ args, input });
    const method = args[2] ?? 'GET';
    const endpoint = args[3] ?? '';
    for (const [key, val] of Object.entries(routes)) {
      const [m, ...rest] = key.split(' ');
      if (m === method && endpoint.includes(rest.join(' '))) {
        if (val.status >= 200 && val.status < 300) {
          return {
            stdout: JSON.stringify(val.json ?? {}),
            stderr: '',
            code: 0,
          };
        }
        const err = new Error(`gh-exec: gh exited with code ${val.status}`);
        err.code = val.status;
        err.name = val.status === 404 ? 'GhNotFoundError' : 'Error';
        throw err;
      }
    }
    return { stdout: '{}', stderr: '', code: 0 };
  };
  exec.calls = calls;
  const gh = createGh(exec);
  gh.__exec = exec;
  return gh;
}

describe('providers/github/branch-protection.js — isNotFoundError', () => {
  it('matches GhNotFoundError by name', () => {
    const err = new Error('not found');
    err.name = 'GhNotFoundError';
    assert.equal(isNotFoundError(err), true);
  });

  it('matches the legacy "failed (404)" message', () => {
    assert.equal(
      isNotFoundError(new Error('rest failed (404): not found')),
      true,
    );
  });

  it('matches HTTP 404 in stderr', () => {
    const err = new Error('boom');
    err.stderr = 'HTTP 404 Not Found';
    assert.equal(isNotFoundError(err), true);
  });

  it('matches err.code === 404 (test mock surface)', () => {
    const err = new Error('boom');
    err.code = 404;
    assert.equal(isNotFoundError(err), true);
  });

  it('does NOT match an unrelated error', () => {
    assert.equal(isNotFoundError(new Error('500 oops')), false);
    assert.equal(isNotFoundError(null), false);
  });
});

describe('providers/github/branch-protection.js — BranchProtectionGateway', () => {
  it('getBranchProtection: returns enabled+raw on 200', async () => {
    const gh = makeFakeGh({
      'GET /repos/o/r/branches/main/protection': {
        status: 200,
        json: {
          required_status_checks: { strict: true, contexts: ['lint'] },
          enforce_admins: { enabled: true },
        },
      },
    });
    const gw = new BranchProtectionGateway({ gh, owner: 'o', repo: 'r' });
    const out = await gw.getBranchProtection('main');
    assert.equal(out.enabled, true);
    assert.deepEqual(out.raw.required_status_checks.contexts, ['lint']);
  });

  it('getBranchProtection: returns enabled=false on 404', async () => {
    const gh = makeFakeGh({
      'GET /repos/o/r/branches/main/protection': { status: 404, json: {} },
    });
    const gw = new BranchProtectionGateway({ gh, owner: 'o', repo: 'r' });
    const out = await gw.getBranchProtection('main');
    assert.equal(out.enabled, false);
  });

  it('setBranchProtection: creates when no rule exists, returns created=true', async () => {
    const gh = makeFakeGh({
      'GET /repos/o/r/branches/main/protection': { status: 404, json: {} },
      'PUT /repos/o/r/branches/main/protection': { status: 200, json: {} },
    });
    const gw = new BranchProtectionGateway({ gh, owner: 'o', repo: 'r' });
    const out = await gw.setBranchProtection('main', {
      contexts: ['lint', 'test'],
    });
    assert.equal(out.created, true);
    assert.deepEqual(out.added.sort(), ['lint', 'test']);
    assert.deepEqual(out.existing, []);
  });

  it('setBranchProtection: additively merges contexts on existing rule', async () => {
    const gh = makeFakeGh({
      'GET /repos/o/r/branches/main/protection': {
        status: 200,
        json: {
          required_status_checks: { strict: true, contexts: ['lint'] },
          enforce_admins: { enabled: false },
        },
      },
      'PUT /repos/o/r/branches/main/protection': { status: 200, json: {} },
    });
    const gw = new BranchProtectionGateway({ gh, owner: 'o', repo: 'r' });
    const out = await gw.setBranchProtection('main', {
      contexts: ['lint', 'test'], // lint already present
    });
    assert.equal(out.created, false);
    assert.deepEqual(out.added, ['test']);
    assert.deepEqual(out.existing, ['lint']);
    // PUT was issued; the body merged both lint + test.
    const putCall = gh.__exec.calls.find((c) => c.args[2] === 'PUT');
    const body = JSON.parse(putCall.input);
    assert.deepEqual(body.required_status_checks.contexts.sort(), [
      'lint',
      'test',
    ]);
  });

  it('setBranchProtection: explicit enforceAdmins=true overrides operator state', async () => {
    const gh = makeFakeGh({
      'GET /repos/o/r/branches/main/protection': {
        status: 200,
        json: {
          required_status_checks: { strict: true, contexts: [] },
          enforce_admins: { enabled: false },
        },
      },
      'PUT /repos/o/r/branches/main/protection': { status: 200, json: {} },
    });
    const gw = new BranchProtectionGateway({ gh, owner: 'o', repo: 'r' });
    await gw.setBranchProtection('main', {
      contexts: [],
      enforceAdmins: true,
    });
    const putCall = gh.__exec.calls.find((c) => c.args[2] === 'PUT');
    const body = JSON.parse(putCall.input);
    assert.equal(body.enforce_admins, true);
  });
});
