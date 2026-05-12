import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const WORKFLOWS_DIR = path.join(REPO_ROOT, '.agents', 'workflows');

const JUSTIFICATION_WINDOW = 3;

const ALLOWLIST = new Set([
  'git-push.md',
  'git-pr-all.md',
  path.join('helpers', '_merge-conflict-template.md'),
]);

function listWorkflowMarkdown(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listWorkflowMarkdown(full));
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      out.push(full);
    }
  }
  return out;
}

function scanForUnjustifiedNoVerify(
  content,
  windowSize = JUSTIFICATION_WINDOW,
) {
  const offenses = [];
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    if (!lines[i].includes('--no-verify')) continue;
    const start = Math.max(0, i - windowSize);
    const end = Math.min(lines.length - 1, i + windowSize);
    let justified = false;
    for (let j = start; j <= end; j += 1) {
      if (/#\s*justification:/i.test(lines[j])) {
        justified = true;
        break;
      }
    }
    if (!justified) {
      offenses.push({ line: i + 1, text: lines[i].trim() });
    }
  }
  return offenses;
}

function formatOffenses(offenses, file) {
  return offenses
    .map(
      (o) =>
        `  ${file}:${o.line} ${o.text}\n    → add an inline "# justification: <reason>" comment within ${JUSTIFICATION_WINDOW} lines, or remove --no-verify.`,
    )
    .join('\n');
}

test('scanForUnjustifiedNoVerify: flags --no-verify without nearby justification', () => {
  const sample = ['git add .', 'git commit --no-verify -m "x"', ''].join('\n');
  const offenses = scanForUnjustifiedNoVerify(sample);
  assert.strictEqual(offenses.length, 1);
  assert.strictEqual(offenses[0].line, 2);
});

test('scanForUnjustifiedNoVerify: passes when justification is on prior line', () => {
  const sample = [
    'git add .',
    '# justification: post-CI remediation; CI gate ran upstream.',
    'git commit --no-verify -m "x"',
  ].join('\n');
  const offenses = scanForUnjustifiedNoVerify(sample);
  assert.deepStrictEqual(offenses, []);
});

test('scanForUnjustifiedNoVerify: passes when justification is within 3 lines after', () => {
  const sample = [
    'git commit --no-verify -m "x"',
    '',
    '',
    '# justification: explained below in prose.',
  ].join('\n');
  const offenses = scanForUnjustifiedNoVerify(sample);
  assert.deepStrictEqual(offenses, []);
});

test('scanForUnjustifiedNoVerify: flags when justification is more than 3 lines away', () => {
  const sample = [
    'git commit --no-verify -m "x"',
    '',
    '',
    '',
    '# justification: too far to count.',
  ].join('\n');
  const offenses = scanForUnjustifiedNoVerify(sample);
  assert.strictEqual(offenses.length, 1);
});

test('scanForUnjustifiedNoVerify: ignores lines without --no-verify', () => {
  const sample = 'git commit -m "no flag here"';
  const offenses = scanForUnjustifiedNoVerify(sample);
  assert.deepStrictEqual(offenses, []);
});

test('workflow markdown: every --no-verify code example carries a justification comment', () => {
  const files = listWorkflowMarkdown(WORKFLOWS_DIR);
  assert.ok(files.length > 0, 'expected at least one workflow markdown file');
  const failures = [];
  for (const file of files) {
    const rel = path.relative(WORKFLOWS_DIR, file);
    if (ALLOWLIST.has(rel)) continue;
    const content = fs.readFileSync(file, 'utf8');
    const offenses = scanForUnjustifiedNoVerify(content);
    if (offenses.length > 0) {
      failures.push(formatOffenses(offenses, path.relative(REPO_ROOT, file)));
    }
  }
  assert.deepStrictEqual(
    failures,
    [],
    `Workflow markdown contains --no-verify code examples without an adjacent "# justification:" comment:\n${failures.join('\n')}`,
  );
});

export {
  ALLOWLIST,
  JUSTIFICATION_WINDOW,
  listWorkflowMarkdown,
  scanForUnjustifiedNoVerify,
};
