/**
 * Pins the anti-thrashing "attack the premise" wording (Story #5898) in the
 * spine, the on-demand procedure, and every role-agent shared prefix.
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);

function read(relPath) {
  return readFileSync(path.join(REPO_ROOT, relPath), 'utf8');
}

function section(body, startPattern, endPattern) {
  const start = body.search(startPattern);
  assert.ok(start >= 0, `section ${startPattern} not found`);
  const rest = body.slice(start);
  const end = rest.slice(1).search(endPattern);
  return end < 0 ? rest : rest.slice(0, end + 1);
}

describe('instructions.md § 1.I', () => {
  const spine = section(
    read('.agents/instructions.md'),
    /^### I\. Anti-Thrashing Protocol/m,
    /^### /m,
  );

  it('opens Re-Plan by naming and attacking the shared premise', () => {
    assert.match(
      spine,
      /stating in one sentence the premise the failed\s+attempts share, and attack\s+it/,
    );
    assert.ok(
      spine.includes(
        'docs/execution-reference.md#anti-thrashing-attack-the-premise',
      ),
    );
  });

  it('keeps the three cues and the no-retry close', () => {
    for (const cue of [
      'failure cluster',
      'research drift',
      'same fix, same failure',
    ]) {
      assert.ok(spine.includes(`**${cue}**`), cue);
    }
    assert.match(spine, /never another just-in-case retry\./);
  });
});

describe('execution-reference premise procedure', () => {
  const proc = section(
    read('.agents/docs/execution-reference.md'),
    /^## Anti-thrashing: attack the premise$/m,
    /^## /m,
  );

  it('defines the second-failure trigger and the blocked yield', () => {
    assert.match(
      proc,
      /\*\*Trigger\.\*\* The \*second\* attempt resting on the same premise/,
    );
    assert.match(proc, /\*\*Unverifiable premise = blocker\.\*\*/);
    assert.match(proc, /`agent::blocked`/);
    assert.match(proc, /held, falsified, or\s+unverifiable/);
    assert.match(proc, /\*\*Worked example\.\*\*/);
  });
});

describe('role-agent shared prefix', () => {
  const dir = '.agents/agents';
  const roles = readdirSync(path.join(REPO_ROOT, dir)).filter((f) =>
    f.endsWith('.md'),
  );

  it('carries the self-contained premise clause in every role file', () => {
    assert.ok(roles.length >= 4);
    for (const role of roles) {
      const prefix = read(`${dir}/${role}`).split('<!-- role-delta:')[0];
      assert.match(
        prefix,
        /write in one sentence the premise the failed\s+fixes share, then verify it with a read or command or remove it\./,
        role,
      );
    }
  });
});
