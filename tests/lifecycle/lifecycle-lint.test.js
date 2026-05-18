// tests/lifecycle/lifecycle-lint.test.js
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  findPromiseAllViolations,
  findWildcardObserverFirewallViolations,
} from '../../.agents/scripts/check-lifecycle-lint.js';

describe('lifecycle-lint/rule-1-no-promise-all', () => {
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'mandrel-lint-1-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('flags Promise.all over listeners under the lifecycle dir', () => {
    const file = path.join(dir, 'bad.js');
    writeFileSync(
      file,
      `
async function emit(event, payload) {
  const listeners = [a, b, c];
  await Promise.all(listeners.map((l) => l(event, payload)));
}
`,
      'utf8',
    );
    const violations = findPromiseAllViolations(dir);
    assert.equal(violations.length, 1);
    assert.equal(violations[0].file, file);
    assert.match(violations[0].hint, /sequentially/);
  });

  it('does not flag files without Promise.all', () => {
    writeFileSync(
      path.join(dir, 'good.js'),
      'async function emit() { for (const l of listeners) await l(); }\n',
      'utf8',
    );
    const violations = findPromiseAllViolations(dir);
    assert.deepEqual(violations, []);
  });

  it('respects lint-lifecycle-disable inline opt-out', () => {
    writeFileSync(
      path.join(dir, 'opted-out.js'),
      'await Promise.all([]); // lint-lifecycle-disable -- justified bulk emit\n',
      'utf8',
    );
    const violations = findPromiseAllViolations(dir);
    assert.deepEqual(violations, []);
  });

  it('recurses into nested directories', () => {
    const nested = path.join(dir, 'listeners', 'deep');
    mkdirSync(nested, { recursive: true });
    const file = path.join(nested, 'bad.js');
    writeFileSync(file, 'Promise.all([])\n', 'utf8');
    const violations = findPromiseAllViolations(dir);
    assert.equal(violations.length, 1);
    assert.equal(violations[0].file, file);
  });
});

describe('lifecycle-lint/rule-2-wildcard-firewall', () => {
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'mandrel-lint-2-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('flags a wildcard listener importing a state-mutating module', () => {
    const file = path.join(dir, 'observer.js');
    writeFileSync(
      file,
      `
import { transitionTicketState } from '../../scripts/update-ticket-state.js';
export function register(bus) {
  bus.on('*', () => transitionTicketState());
}
`,
      'utf8',
    );
    const violations = findWildcardObserverFirewallViolations(dir);
    assert.equal(violations.length, 1);
    assert.equal(violations[0].file, file);
    assert.match(violations[0].hint, /state-mutating/);
  });

  it('does not flag wildcard observers that only import safe modules', () => {
    writeFileSync(
      path.join(dir, 'safe.js'),
      `
import { writeFileSync } from 'node:fs';
export function register(bus) { bus.on('*', () => {}); }
`,
      'utf8',
    );
    const violations = findWildcardObserverFirewallViolations(dir);
    assert.deepEqual(violations, []);
  });

  it('does not flag non-wildcard listeners that import state-mutating modules', () => {
    writeFileSync(
      path.join(dir, 'named.js'),
      `
import { transitionTicketState } from '../../scripts/update-ticket-state.js';
export function register(bus) { bus.on('wave.end', () => transitionTicketState()); }
`,
      'utf8',
    );
    const violations = findWildcardObserverFirewallViolations(dir);
    assert.deepEqual(violations, []);
  });

  it('supports a custom blocklist for testing future bans', () => {
    writeFileSync(
      path.join(dir, 'custom.js'),
      `
import { foo } from '../scary/danger.js';
export function register(bus) { bus.on('*', foo); }
`,
      'utf8',
    );
    const violations = findWildcardObserverFirewallViolations(dir, {
      blocklist: ['danger.js'],
    });
    assert.equal(violations.length, 1);
    assert.match(violations[0].hint, /danger\.js/);
  });
});
