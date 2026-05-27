/**
 * story-deliver-script-references.test.js — Phase 5 CR-1 regression guard.
 *
 * Greps every `node .agents/scripts/<name>.js` invocation out of the
 * workflow markdown under `.agents/workflows/*.md` and asserts the
 * corresponding script file exists on disk.
 *
 * Background: Task #3157 deleted `.agents/scripts/story-task-progress.js`
 * but `/story-deliver` and `/epic-deliver` continued to reference it,
 * MODULE_NOT_FOUND-ing every Story sub-agent. This test prevents that
 * drift by tying the workflow prose to the on-disk script surface.
 */

import { strict as assert } from 'node:assert';
import { access, constants, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const WORKFLOWS_DIR = path.join(REPO_ROOT, '.agents', 'workflows');
const SCRIPTS_DIR = path.join(REPO_ROOT, '.agents', 'scripts');

// Matches: `node .agents/scripts/<name>.js` and captures `<name>`.
// Restricts to script names that look like identifiers (alphanum, dash,
// underscore) so backtick-quoted prose like `node .agents/scripts/<name>.js`
// in a template snippet (with literal `<name>` placeholder) is excluded.
const INVOCATION_RE =
  /node\s+\.agents\/scripts\/([A-Za-z0-9][A-Za-z0-9._-]*)\.js\b/g;

async function readWorkflowFiles() {
  const entries = await readdir(WORKFLOWS_DIR, { withFileTypes: true });
  const files = entries
    .filter((e) => e.isFile() && e.name.endsWith('.md'))
    .map((e) => path.join(WORKFLOWS_DIR, e.name));
  return files;
}

async function fileExists(p) {
  try {
    await access(p, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

test('every node .agents/scripts/<name>.js invocation in workflows resolves to an on-disk script', async () => {
  const files = await readWorkflowFiles();
  assert.ok(files.length > 0, 'expected at least one workflow markdown file');

  const missing = [];
  for (const file of files) {
    const text = await readFile(file, 'utf8');
    const matches = text.matchAll(INVOCATION_RE);
    for (const m of matches) {
      const scriptName = m[1];
      const scriptPath = path.join(SCRIPTS_DIR, `${scriptName}.js`);
      // Skip if path uses subdirectories (none today, but defensive).
      if (scriptName.includes('/')) continue;
      const exists = await fileExists(scriptPath);
      if (!exists) {
        missing.push({
          workflow: path.relative(REPO_ROOT, file),
          scriptName: `${scriptName}.js`,
        });
      }
    }
  }

  assert.deepEqual(
    missing,
    [],
    `Workflow files reference scripts that do not exist on disk:\n${missing
      .map((m) => `  - ${m.workflow} → ${m.scriptName}`)
      .join('\n')}`,
  );
});
