import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const AGENTS = path.join(ROOT, '.agents');

const FORBIDDEN = [
  { name: '/sprint-execute', regex: /\/sprint-execute(?![a-zA-Z-])/g },
  { name: '/sprint-plan', regex: /\/sprint-plan(?![a-zA-Z-])/g },
  { name: '/sprint-close', regex: /\/sprint-close(?![a-zA-Z-])/g },
  { name: 'agent::dispatching', regex: /agent::dispatching\b/g },
  { name: 'agent::planning', regex: /agent::planning\b/g },
  { name: 'agent::decomposing', regex: /agent::decomposing\b/g },
];

function walkMarkdown(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkMarkdown(full, out);
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      out.push(full);
    }
  }
  return out;
}

describe('renamed-terms drift guard (Epic #900)', () => {
  it('no /sprint-{execute,plan,close} literal or deleted-label name appears in .agents/**/*.md', () => {
    const files = walkMarkdown(AGENTS);
    const offenders = [];
    for (const file of files) {
      const text = fs.readFileSync(file, 'utf8');
      const lines = text.split(/\r?\n/);
      for (const { name, regex } of FORBIDDEN) {
        regex.lastIndex = 0;
        for (let i = 0; i < lines.length; i++) {
          if (regex.test(lines[i])) {
            offenders.push({
              file: path.relative(ROOT, file),
              line: i + 1,
              term: name,
              snippet: lines[i].trim().slice(0, 160),
            });
          }
          regex.lastIndex = 0;
        }
      }
    }
    assert.equal(
      offenders.length,
      0,
      `Found ${offenders.length} drift hit(s):\n${offenders
        .map((o) => `  ${o.file}:${o.line}  [${o.term}]  ${o.snippet}`)
        .join('\n')}`,
    );
  });
});
