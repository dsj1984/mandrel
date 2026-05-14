import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const WORKFLOWS_DIR = path.join(REPO_ROOT, '.agents', 'workflows');

const RETIRED_FLAT_KEYS = [
  {
    key: 'qualityGate',
    replacement: 'github.branchProtection.requiredChecks',
    epic: 'Epic #730 Story 4 → Epic #1720 Story #1739',
  },
  {
    key: 'lintBaselinePath',
    replacement: 'delivery.quality.baselines.lint.path',
    epic: 'Epic #730 Story 6 → Epic #1720 Story #1739',
  },
];

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

function scanForRetiredKeys(content, retired = RETIRED_FLAT_KEYS) {
  const offenses = [];
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const isLegacyCallout = /\b(legacy|retired)\b/i.test(line);
    if (isLegacyCallout) continue;
    for (const { key, replacement } of retired) {
      const re = new RegExp(`\\b${key}\\b`);
      if (re.test(line)) {
        offenses.push({ line: i + 1, key, replacement, text: line.trim() });
      }
    }
  }
  return offenses;
}

function formatOffenses(offenses, file) {
  return offenses
    .map(
      (o) =>
        `  ${file}:${o.line} [${o.key}] ${o.text}\n    → use ${o.replacement}`,
    )
    .join('\n');
}

test('scanForRetiredKeys: flags qualityGate', () => {
  const sample = '`.agentrc.json → qualityGate`';
  const offenses = scanForRetiredKeys(sample);
  assert.strictEqual(offenses.length, 1);
  assert.strictEqual(offenses[0].key, 'qualityGate');
});

test('scanForRetiredKeys: flags lintBaselinePath', () => {
  const sample = 'Override via agentSettings.lintBaselinePath.';
  const offenses = scanForRetiredKeys(sample);
  assert.strictEqual(offenses.length, 1);
  assert.strictEqual(offenses[0].key, 'lintBaselinePath');
});

test('scanForRetiredKeys: ignores lines tagged legacy', () => {
  const sample = 'Legacy: qualityGate flat key was retired in 5.x.';
  const offenses = scanForRetiredKeys(sample);
  assert.strictEqual(offenses.length, 0);
});

test('scanForRetiredKeys: does not match nested replacement (prGate)', () => {
  const sample = 'Override via `.agentrc.json → agentSettings.quality.prGate`.';
  const offenses = scanForRetiredKeys(sample);
  assert.strictEqual(offenses.length, 0);
});

test('workflow markdown has no retired flat config keys', () => {
  const files = listWorkflowMarkdown(WORKFLOWS_DIR);
  assert.ok(files.length > 0, 'expected at least one workflow markdown file');
  const failures = [];
  for (const file of files) {
    const content = fs.readFileSync(file, 'utf8');
    const offenses = scanForRetiredKeys(content);
    if (offenses.length > 0) {
      failures.push(formatOffenses(offenses, path.relative(REPO_ROOT, file)));
    }
  }
  assert.deepStrictEqual(
    failures,
    [],
    `Workflow markdown references retired flat config keys (these moved into nested agentSettings.* blocks):\n${failures.join('\n')}`,
  );
});

export { listWorkflowMarkdown, RETIRED_FLAT_KEYS, scanForRetiredKeys };
