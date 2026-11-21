import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);
const read = (rel) => readFileSync(path.join(REPO_ROOT, rel), 'utf8');
const flat = (text) => text.replace(/\s+/g, ' ');

/** The body of a `## ` section, up to the next one. */
function section(src, heading) {
  const start = src.indexOf(`\n${heading}\n`);
  assert.notEqual(start, -1, `no "${heading}" section`);
  const rest = src.slice(start + heading.length + 2);
  const end = rest.indexOf('\n## ');
  return end === -1 ? rest : rest.slice(0, end);
}

const MAY_SAY = ['contract', 'invariant', 'non-obvious', 'unit', 'null'];
const MUST_NOT = [
  /restate the name or type/,
  /repeat the file path/,
  /narrate the change/,
  /cite a Story, PR or issue number/,
];

describe('shipped comment writing rule', () => {
  const guardrails = read(
    '.agents/workflows/helpers/code-quality-guardrails.md',
  );
  const worker = read('.agents/agents/story-worker.md');

  it('guardrails state the rule directly before Deliberate shortcuts', () => {
    const body = section(guardrails, '## Comments');
    const after = guardrails.slice(guardrails.indexOf(body) + body.length);
    assert.ok(after.startsWith('\n## Deliberate shortcuts\n'));

    const text = flat(body);
    for (const word of MAY_SAY) assert.ok(text.includes(word), word);
    for (const pattern of MUST_NOT) assert.match(text, pattern);
    assert.match(text, /once, at the narrowest scope that owns it/);
    assert.match(text, /Type tags and tool directives/);
    assert.match(text, /one sanctioned issue reference/);
    assert.match(text, /do not trim comments by formula/);
  });

  it('guardrails state the rule in consumer terms', () => {
    const body = section(guardrails, '## Comments');
    assert.doesNotMatch(body, /check-comment-policy|\.agents\/scripts/);
  });

  it('a story-worker boots with the rule beside the shortcut form', () => {
    const text = flat(section(worker, '## Smallest complete change (MUST)'));
    for (const word of MAY_SAY) assert.ok(text.includes(word), word);
    for (const pattern of MUST_NOT) {
      assert.match(text, new RegExp(pattern.source, 'i'));
    }
    assert.match(text, /once, at the narrowest scope/);
    assert.match(text, /Type tags and tool directives stay/);
  });
});
