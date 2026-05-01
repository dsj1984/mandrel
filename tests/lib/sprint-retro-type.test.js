import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RETRO_SKILL_PATH = path.resolve(
  __dirname,
  '..',
  '..',
  '.agents',
  'workflows',
  'helpers',
  'epic-retro.md',
);

test('sprint-retro skill posts via `retro` type and never falls back to notification', async () => {
  const body = await readFile(RETRO_SKILL_PATH, 'utf8');

  assert.match(
    body,
    /--marker\s+retro\b/,
    'skill must instruct callers to use `--marker retro` for the final retro comment (post-structured-comment.js CLI flag)',
  );
  assert.match(
    body,
    /type:\s*'retro-partial'/,
    'skill must instruct upsert of `retro-partial` for in-progress checkpoints',
  );

  const lines = body.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/type:\s*['"`]notification['"`]/.test(line)) {
      assert.fail(
        `epic-retro.md line ${i + 1} routes through type: 'notification' — ` +
          `retro must use type: 'retro' (regression guard for Story #449).`,
      );
    }
  }

  assert.match(
    body,
    /Never.*notify\.js/i,
    'skill must explicitly forbid routing the retro body through notify.js',
  );
});
