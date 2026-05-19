import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  checkFile,
  discoverMarkdown,
  extractLinks,
  extractSlashTokens,
  maskCodeRegions,
  RETIRED_COMMANDS,
  runCheck,
  SLASH_ALLOWLIST,
} from '../.agents/scripts/check-doc-links.js';

/**
 * Unit coverage for the doc-links / slash-command resolver.
 *
 * Strategy: build a minimal fake repo in tmpdir with a `docs/` tree, a
 * `.agents/` tree, and a `.agents/workflows/` directory, then drive
 * `runCheck` with that repo root. Three required scenarios live below
 * (passing fixture, broken relative link, retired token); a handful of
 * additional helper-level tests pin the masking and tokenizer behaviour.
 */

function makeFakeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'check-doc-links-'));
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  fs.mkdirSync(path.join(root, 'docs', 'archive'), { recursive: true });
  fs.mkdirSync(path.join(root, '.agents'), { recursive: true });
  fs.mkdirSync(path.join(root, '.agents', 'workflows'), { recursive: true });
  // Seed two workflow files so /epic-plan and /story-deliver resolve.
  fs.writeFileSync(
    path.join(root, '.agents', 'workflows', 'epic-plan.md'),
    '# epic-plan\n',
  );
  fs.writeFileSync(
    path.join(root, '.agents', 'workflows', 'story-deliver.md'),
    '# story-deliver\n',
  );
  return root;
}

function write(root, relPath, body) {
  const abs = path.join(root, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body);
  return abs;
}

test('runCheck (a) passing fixture: clean tree exits 0 with zero violations', () => {
  const root = makeFakeRepo();
  // A doc with a valid relative link, a valid slash command, an allowlisted
  // token, an external URL, and a pure anchor — all should pass.
  write(
    root,
    'docs/intro.md',
    '# Intro\n\n' +
      'See [the spec](spec.md) and run [/epic-plan](../.agents/workflows/epic-plan.md).\n\n' +
      'Visit https://example.com/issues/1 for context, store scratch in /temp/.\n\n' +
      'Jump to [later](#later).\n\n' +
      '## later\n',
  );
  write(root, 'docs/spec.md', '# Spec\n');
  // Archive content is excluded even when malformed.
  write(
    root,
    'docs/archive/old.md',
    '[dangling](./does-not-exist.md) and /agents-bootstrap-github should be ignored here\n',
  );
  // CHANGELOG.md is excluded even when malformed.
  write(root, 'docs/CHANGELOG.md', '[dangling](./nope.md)\n');

  const result = runCheck({ repoRoot: root, scanRoots: ['docs', '.agents'] });
  assert.equal(
    result.exitCode,
    0,
    `unexpected violations: ${JSON.stringify(result.violations, null, 2)}`,
  );
  assert.equal(result.violations.length, 0);
  assert.ok(result.scanned >= 2);
});

test('runCheck (b) broken relative link: exits non-zero and names the file:line', () => {
  const root = makeFakeRepo();
  write(
    root,
    'docs/intro.md',
    '# Intro\n\n' + 'Line two has [a bad link](./nope.md).\n',
  );
  const result = runCheck({ repoRoot: root, scanRoots: ['docs', '.agents'] });
  assert.equal(result.exitCode, 1);
  const v = result.violations.find((x) => x.kind === 'broken-link');
  assert.ok(
    v,
    `expected broken-link violation; got ${JSON.stringify(result.violations)}`,
  );
  assert.equal(v.file, 'docs/intro.md');
  assert.equal(v.line, 3);
  assert.match(v.message, /nope\.md/);
});

test('runCheck (c) retired /agents-bootstrap-github token: exits non-zero and names file:line', () => {
  const root = makeFakeRepo();
  write(
    root,
    'docs/intro.md',
    '# Intro\n\n' + 'Do not run /agents-bootstrap-github any more.\n',
  );
  const result = runCheck({ repoRoot: root, scanRoots: ['docs', '.agents'] });
  assert.equal(result.exitCode, 1);
  const v = result.violations.find((x) => x.kind === 'retired-command');
  assert.ok(
    v,
    `expected retired-command violation; got ${JSON.stringify(result.violations)}`,
  );
  assert.equal(v.file, 'docs/intro.md');
  assert.equal(v.line, 3);
  assert.match(v.message, /agents-bootstrap-github/);
});

test('runCheck: unknown slash command surfaces a violation when no allowlist hit', () => {
  const root = makeFakeRepo();
  write(
    root,
    'docs/intro.md',
    '# Intro\n\n' + 'Try /not-a-real-command for fun.\n',
  );
  const result = runCheck({ repoRoot: root, scanRoots: ['docs', '.agents'] });
  assert.equal(result.exitCode, 1);
  const v = result.violations.find((x) => x.kind === 'unknown-command');
  assert.ok(v);
  assert.equal(v.file, 'docs/intro.md');
  assert.equal(v.line, 3);
  assert.match(v.message, /not-a-real-command/);
});

test('runCheck: tokens inside fenced code blocks are ignored', () => {
  const root = makeFakeRepo();
  write(
    root,
    'docs/intro.md',
    '# Intro\n\n' +
      '```bash\n' +
      '/not-a-real-command\n' +
      '/agents-bootstrap-github\n' +
      '```\n',
  );
  const result = runCheck({ repoRoot: root, scanRoots: ['docs', '.agents'] });
  assert.equal(
    result.exitCode,
    0,
    `unexpected violations: ${JSON.stringify(result.violations)}`,
  );
});

test('runCheck: links inside inline code spans are ignored', () => {
  const root = makeFakeRepo();
  write(
    root,
    'docs/intro.md',
    '# Intro\n\n' + 'Inline `[bad](./nope.md)` should not be checked.\n',
  );
  const result = runCheck({ repoRoot: root, scanRoots: ['docs', '.agents'] });
  assert.equal(result.exitCode, 0);
});

test('maskCodeRegions: zeroes fenced regions and inline spans while preserving line count', () => {
  const src = 'a\n```\nbad /token\n```\nb `inline /token` c\n';
  const masked = maskCodeRegions(src);
  // Same number of newlines preserved
  assert.equal(masked.split('\n').length, src.split('\n').length);
  assert.equal(masked.includes('bad /token'), false);
  assert.equal(masked.includes('inline /token'), false);
});

test('extractLinks: returns target + line for inline markdown links', () => {
  const src = '# H\n\nSee [x](./y.md) and [z](http://example.com).\n';
  const links = extractLinks(maskCodeRegions(src));
  assert.equal(links.length, 2);
  assert.equal(links[0].target, './y.md');
  assert.equal(links[0].line, 3);
  assert.equal(links[1].target, 'http://example.com');
});

test('extractSlashTokens: ignores tokens prefixed by word chars or colons (URL paths)', () => {
  const src = 'visit https://example.com/foo and /bar but not text/bar\n';
  const tokens = extractSlashTokens(maskCodeRegions(src));
  const names = tokens.map((t) => t.token);
  assert.deepEqual(names, ['bar']);
});

test('discoverMarkdown: skips docs/archive/** and docs/CHANGELOG.md', () => {
  const root = makeFakeRepo();
  write(root, 'docs/keep.md', '# keep\n');
  write(root, 'docs/CHANGELOG.md', '# changelog\n');
  write(root, 'docs/archive/old.md', '# old\n');
  const files = discoverMarkdown(root, ['docs']);
  const rels = files.map((f) =>
    path.relative(root, f).split(path.sep).join('/'),
  );
  assert.ok(rels.includes('docs/keep.md'));
  assert.equal(rels.includes('docs/CHANGELOG.md'), false);
  assert.equal(rels.includes('docs/archive/old.md'), false);
});

test('checkFile: anchor-only and protocol-relative targets are skipped', () => {
  const root = makeFakeRepo();
  const abs = write(root, 'docs/intro.md', '[a](#x) and [b](//example.com)\n');
  const v = checkFile(abs, root);
  assert.equal(v.length, 0);
});

test('static constants: retired blocklist seeded with agents-bootstrap-github; allowlist includes /temp/', () => {
  assert.ok(RETIRED_COMMANDS.has('agents-bootstrap-github'));
  assert.ok(SLASH_ALLOWLIST.has('temp'));
});
