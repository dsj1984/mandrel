import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const AGENTS = path.join(ROOT, '.agents');
const DOCS = path.join(ROOT, 'docs');

const FORBIDDEN = [
  { name: '/sprint-execute', regex: /\/sprint-execute(?![a-zA-Z-])/g },
  { name: '/sprint-plan', regex: /\/sprint-plan(?![a-zA-Z-])/g },
  { name: '/sprint-close', regex: /\/sprint-close(?![a-zA-Z-])/g },
  { name: 'agent::dispatching', regex: /agent::dispatching\b/g },
  { name: 'agent::planning', regex: /agent::planning\b/g },
  { name: 'agent::decomposing', regex: /agent::decomposing\b/g },
];

const DOCS_EXCLUDE_FILES = new Set(
  [
    path.join(DOCS, 'CHANGELOG.md'),
    path.join(DOCS, 'decisions.md'),
    path.join(DOCS, 'deprecation-register.md'),
  ].map((p) => path.normalize(p)),
);

const DOCS_EXCLUDE_DIRS = [
  path.join(DOCS, 'archive'),
  path.join(DOCS, 'retros'),
].map((p) => path.normalize(p));

function isDocsExcluded(full) {
  const normalized = path.normalize(full);
  if (DOCS_EXCLUDE_FILES.has(normalized)) return true;
  return DOCS_EXCLUDE_DIRS.some(
    (dir) => normalized === dir || normalized.startsWith(dir + path.sep),
  );
}

function walkMarkdown(dir, { excludeFn } = {}, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (excludeFn && excludeFn(full)) continue;
    if (entry.isDirectory()) {
      walkMarkdown(full, { excludeFn }, out);
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      out.push(full);
    }
  }
  return out;
}

function findOffenders(files) {
  const offenders = [];
  for (const file of files) {
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    for (const { name, regex } of FORBIDDEN) {
      for (let i = 0; i < lines.length; i++) {
        regex.lastIndex = 0;
        if (regex.test(lines[i])) {
          offenders.push({
            file: path.relative(ROOT, file),
            line: i + 1,
            term: name,
            snippet: lines[i].trim().slice(0, 160),
          });
        }
      }
    }
  }
  return offenders;
}

function formatOffenders(offenders) {
  return offenders
    .map((o) => `  ${o.file}:${o.line}  [${o.term}]  ${o.snippet}`)
    .join('\n');
}

describe('renamed-terms drift guard (Epic #900)', () => {
  it('no /sprint-{execute,plan,close} literal or deleted-label name appears in .agents/**/*.md', () => {
    const files = walkMarkdown(AGENTS);
    const offenders = findOffenders(files);
    assert.equal(
      offenders.length,
      0,
      `Found ${offenders.length} drift hit(s) in .agents/:\n${formatOffenders(offenders)}`,
    );
  });

  it('no /sprint-{execute,plan,close} literal or deleted-label name appears in docs/**/*.md (history files excluded)', () => {
    const files = walkMarkdown(DOCS, { excludeFn: isDocsExcluded });
    const offenders = findOffenders(files);
    assert.equal(
      offenders.length,
      0,
      `Found ${offenders.length} drift hit(s) in docs/:\n${formatOffenders(offenders)}`,
    );
  });
});
