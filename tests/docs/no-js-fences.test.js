import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

const TARGETS = [
  '.agents/workflows/epic-deliver.md',
  '.agents/workflows/story-execute.md',
  '.agents/workflows/helpers/task-execute.md',
];

const JS_FENCE_RE = /^```(js|javascript)\b/m;

for (const relPath of TARGETS) {
  test(`no JS code fences in ${relPath}`, () => {
    const absPath = path.join(REPO_ROOT, relPath);
    const body = readFileSync(absPath, 'utf8');

    // Strip <!-- ... --> HTML comments before scanning so an intentional
    // narrative comment near a fence-mention does not falsely match.
    const stripped = body.replace(/<!--[\s\S]*?-->/g, '');

    const match = stripped.match(JS_FENCE_RE);
    assert.strictEqual(
      match,
      null,
      `${relPath} contains a fenced \`\`\`${match?.[1]} block — these MDs must reference CLIs only.`,
    );

    // Belt-and-braces: scan every line independently so the regex above
    // can't be tricked by a leading blank line at offset 0.
    const lines = stripped.split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (/^\s*```(js|javascript)\b/.test(line)) {
        assert.fail(
          `${relPath}:${i + 1} starts a JS fence (\`${line.trim()}\`).`,
        );
      }
    }
  });
}
