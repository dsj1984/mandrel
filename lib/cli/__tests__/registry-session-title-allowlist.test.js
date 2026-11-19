// lib/cli/__tests__/registry-session-title-allowlist.test.js
/**
 * The `session-title-allowlist` doctor advisory: with session titles on, a
 * settings file should allow the desktop app's rename tool.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import { makeTempDir } from '../../../.agents/scripts/lib/test-temp.js';
import { registry } from '../registry.js';

const check = registry.find(
  (entry) => entry.name === 'session-title-allowlist',
);
const TOOL = 'mcp__ccd_session_mgmt__set_session_title';

/** A project root with `.agentrc.json` and the given `.claude/` files (raw strings). */
function project({ agentrc = {}, local, settings = {} } = {}) {
  const root = fs.realpathSync(makeTempDir('doctor-session-title-'));
  fs.writeFileSync(path.join(root, '.agentrc.json'), JSON.stringify(agentrc));
  if (local) {
    fs.writeFileSync(
      path.join(root, '.agentrc.local.json'),
      JSON.stringify(local),
    );
  }
  for (const [name, body] of Object.entries(settings)) {
    fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(root, '.claude', name), body);
  }
  return root;
}

const allowing = (...allow) => JSON.stringify({ permissions: { allow } });
const run = (spec) => check.run({ projectRoot: project(spec) });
const titlesOff = { delivery: { routing: { sessionTitles: false } } };

describe('doctor check: session-title-allowlist', () => {
  it('is registered as an advisory check', () => {
    assert.ok(check, 'the registry must carry a session-title-allowlist entry');
    assert.equal(check.advisory, true);
  });

  it('names the missing entry when titles are on and no settings file allows it', async () => {
    const result = await run({
      settings: { 'settings.json': allowing('Read', 'mcp__github__*') },
    });
    assert.equal(result.ok, true, 'advisory: never fails doctor');
    assert.match(result.detail, /no settings file allows the rename tool/);
    assert.ok(result.detail.includes(`"${TOOL}"`));
  });

  for (const entry of [
    TOOL,
    'mcp__ccd_session_mgmt__*',
    'mcp__ccd_session_mgmt',
  ]) {
    it(`reports present when settings.json allows ${entry}`, async () => {
      const result = await run({
        settings: { 'settings.json': allowing(entry) },
      });
      assert.equal(result.ok, true);
      assert.match(result.detail, /settings\.json allows .* need no prompt/);
    });
  }

  it('accepts the entry from the per-operator settings.local.json', async () => {
    const result = await run({
      settings: {
        'settings.json': allowing('Read'),
        'settings.local.json': allowing(TOOL),
      },
    });
    assert.match(result.detail, /settings\.local\.json allows/);
  });

  it('reports nothing to check when titles are off, read through the local overlay', async () => {
    const result = await run({
      local: titlesOff,
      settings: { 'settings.json': allowing('Read') },
    });
    assert.deepEqual(result, {
      ok: true,
      detail: 'session titles are off; nothing to check',
    });
  });

  it('reports nothing to check when no Claude Code settings file exists', async () => {
    const result = await run();
    assert.deepEqual(result, {
      ok: true,
      detail: 'no Claude Code settings file found; nothing to check',
    });
  });

  it('names a malformed settings file instead of throwing', async () => {
    const result = await run({ settings: { 'settings.json': '{ not json' } });
    assert.equal(result.ok, true);
    assert.match(result.detail, /\.claude\/settings\.json is not valid JSON/);
    assert.ok(result.detail.includes(TOOL));
  });
});
