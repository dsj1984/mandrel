import assert from 'node:assert/strict';
import test from 'node:test';

import { applyHeader } from '../../.agents/scripts/lib/command-header.js';

const HEADER = '<!-- H -->\n\n';

test('applyHeader: injects the header after a leading frontmatter block', () => {
  const source = '---\ndescription: x\n---\n\n# Body\n';
  const out = applyHeader(source, HEADER);
  // Frontmatter MUST stay on line 1 so Claude Code parses it.
  assert.ok(out.startsWith('---\n'));
  assert.equal(out, '---\ndescription: x\n---\n\n<!-- H -->\n\n# Body\n');
});

test('applyHeader: handles CRLF frontmatter and keeps it on line 1', () => {
  const source = '---\r\ndescription: x\r\n---\r\n\r\nBody\r\n';
  const out = applyHeader(source, HEADER);
  assert.ok(out.startsWith('---\r\n'));
  assert.match(out, /^---\r\n[\s\S]*?\r\n---\r\n\n<!-- H -->/);
});

test('applyHeader: prepends the header when there is no frontmatter', () => {
  const source = '# Body only\n';
  assert.equal(applyHeader(source, HEADER), `${HEADER}# Body only\n`);
});

test('applyHeader: a stray `---` later in the body is not treated as frontmatter', () => {
  const source = '# Title\n\nsome text\n\n---\n\nmore\n';
  // No leading frontmatter → header prepended, body untouched.
  assert.equal(applyHeader(source, HEADER), HEADER + source);
});
