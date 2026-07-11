import assert from 'node:assert';
import { test } from 'node:test';
import {
  isChangelogClass,
  parseFreshnessArgs,
  renderFreshnessFailureMessage,
  renderFreshnessLine,
  renderFreshnessSuccessMessage,
  resolveDocList,
  runFreshnessGate,
} from '../.agents/scripts/validate-docs-freshness.js';

test('parseFreshnessArgs: invalid epic id returns null', () => {
  assert.strictEqual(parseFreshnessArgs([]).epicId, null);
  assert.strictEqual(parseFreshnessArgs(['--epic', '0']).epicId, null);
  assert.strictEqual(parseFreshnessArgs(['--epic', 'oops']).epicId, null);
});

test('parseFreshnessArgs: parses --json and --docs comma list', () => {
  const out = parseFreshnessArgs([
    '--epic',
    '7',
    '--json',
    '--docs',
    ' a.md , b.md ,, ',
  ]);
  assert.strictEqual(out.epicId, 7);
  assert.strictEqual(out.json, true);
  assert.deepStrictEqual(out.docsList, ['a.md', 'b.md']);
});

test('parseFreshnessArgs: omits --docs leaves docsList null', () => {
  const out = parseFreshnessArgs(['--epic', '5']);
  assert.strictEqual(out.docsList, null);
  assert.strictEqual(out.json, false);
});

test('renderFreshnessLine: pass + fail variants', () => {
  assert.strictEqual(
    renderFreshnessLine({ pass: true, file: 'a.md', reason: 'commit' }),
    '[docs-freshness] ✅ a.md — commit',
  );
  assert.strictEqual(
    renderFreshnessLine({ pass: false, file: 'b.md', reason: 'no ref' }),
    '[docs-freshness] ❌ b.md — no ref',
  );
});

test('renderFreshnessFailureMessage references epic id twice', () => {
  const msg = renderFreshnessFailureMessage(99);
  assert.match(msg, /FAILED for Epic #99/);
  assert.match(msg, /references #99/);
});

test('renderFreshnessFailureMessage names failing file and rewrite-not-append contract', () => {
  const msg = renderFreshnessFailureMessage(4430, [
    { file: 'docs/architecture.md', pass: false },
    { file: 'docs/CHANGELOG.md', pass: true },
  ]);
  // Names the failing file (and not the passing one).
  assert.match(msg, /docs\/architecture\.md/);
  assert.doesNotMatch(msg, /Failing file\(s\): [^\n]*CHANGELOG/);
  // States the rewrite-not-append contract explicitly.
  assert.match(msg, /REWRITTEN/);
  assert.match(msg, /NOT by appending/);
});

test('isChangelogClass: only changelog-basename files qualify', () => {
  assert.strictEqual(isChangelogClass('docs/CHANGELOG.md'), true);
  assert.strictEqual(isChangelogClass('CHANGELOG.md'), true);
  assert.strictEqual(isChangelogClass('changelog.mdx'), true);
  assert.strictEqual(isChangelogClass('docs/architecture.md'), false);
  assert.strictEqual(isChangelogClass('README.md'), false);
});

test('renderFreshnessSuccessMessage formats count + epic id', () => {
  assert.strictEqual(
    renderFreshnessSuccessMessage(7, 4),
    '[docs-freshness] ✅ All 4 doc(s) reference Epic #7.',
  );
});

test('resolveDocList merges release.docs and docsContextFiles under paths.docsRoot', () => {
  const docs = resolveDocList({
    release: { docs: ['README.md', 'docs/CHANGELOG.md'] },
    docsContextFiles: ['architecture.md', 'decisions.md'],
    paths: { docsRoot: 'docs' },
  });
  assert.deepStrictEqual(docs, [
    'README.md',
    'docs/CHANGELOG.md',
    'docs/architecture.md',
    'docs/decisions.md',
  ]);
});

test('resolveDocList deduplicates identical entries', () => {
  const docs = resolveDocList({
    release: { docs: ['docs/architecture.md'] },
    docsContextFiles: ['architecture.md'],
    paths: { docsRoot: 'docs' },
  });
  assert.deepStrictEqual(docs, ['docs/architecture.md']);
});

test('resolveDocList returns [] when nothing is configured', () => {
  assert.deepStrictEqual(resolveDocList({}), []);
  assert.deepStrictEqual(resolveDocList({ release: {} }), []);
});

test('runFreshnessGate passes when commit message references the Epic', () => {
  const { ok, results } = runFreshnessGate({
    epicId: 349,
    docs: ['docs/CHANGELOG.md'],
    readFileImpl: () => 'content without epic ref',
    commitsForFile: () => ['abc123'],
  });
  assert.strictEqual(ok, true);
  assert.strictEqual(results[0].pass, true);
  assert.match(results[0].reason, /commit.*#349/);
});

test('runFreshnessGate passes when a changelog body references the Epic', () => {
  const { ok, results } = runFreshnessGate({
    epicId: 349,
    docs: ['docs/CHANGELOG.md'],
    readFileImpl: () => 'Release notes for Epic #349.',
    commitsForFile: () => [],
  });
  assert.strictEqual(ok, true);
  assert.match(results[0].reason, /changelog body annotation.*#349/);
});

test('runFreshnessGate fails when neither commit nor body references the Epic', () => {
  const { ok, results } = runFreshnessGate({
    epicId: 349,
    docs: ['docs/CHANGELOG.md'],
    readFileImpl: () => 'unrelated content',
    commitsForFile: () => [],
  });
  assert.strictEqual(ok, false);
  assert.strictEqual(results[0].pass, false);
  assert.match(results[0].reason, /no commit message or changelog body/);
});

test('runFreshnessGate does not accept #3490 when checking for #349', () => {
  const { ok } = runFreshnessGate({
    epicId: 349,
    docs: ['docs/CHANGELOG.md'],
    readFileImpl: () => 'bumped issue #3490 reference',
    commitsForFile: () => [],
  });
  assert.strictEqual(ok, false);
});

test('runFreshnessGate handles unreadable files without throwing', () => {
  const { ok, results } = runFreshnessGate({
    epicId: 349,
    docs: ['docs/missing.md'],
    readFileImpl: () => {
      throw new Error('ENOENT');
    },
    commitsForFile: () => [],
  });
  assert.strictEqual(ok, false);
  assert.strictEqual(results[0].pass, false);
});

test('runFreshnessGate reports pass + fail rows independently across docs', () => {
  // A changelog body annotation passes; a silent non-changelog doc fails.
  const { ok, results } = runFreshnessGate({
    epicId: 12,
    docs: ['docs/CHANGELOG.md', 'docs/architecture.md'],
    readFileImpl: (abs) =>
      abs.endsWith('CHANGELOG.md') ? 'mentions #12 explicitly' : 'silent',
    commitsForFile: () => [],
  });
  assert.strictEqual(ok, false);
  assert.strictEqual(results[0].pass, true);
  assert.strictEqual(results[1].pass, false);
});

// --- Changelog-only body-annotation cutover (Story #4436) ---

test('runFreshnessGate: non-changelog doc with only an appended annotation FAILS', () => {
  const { ok, results } = runFreshnessGate({
    epicId: 4430,
    docs: ['docs/architecture.md'],
    readFileImpl: () => 'Architecture notes.\n\nUpdated for #4430.',
    commitsForFile: () => [],
  });
  assert.strictEqual(ok, false);
  assert.strictEqual(results[0].pass, false);
  // The failure names the file and the rewrite-not-append contract.
  assert.match(results[0].reason, /docs\/architecture\.md/);
  assert.match(results[0].reason, /REWRITTEN/);
});

test('runFreshnessGate: changelog file still passes via body annotation', () => {
  const { ok, results } = runFreshnessGate({
    epicId: 4430,
    docs: ['docs/CHANGELOG.md'],
    readFileImpl: () => 'All notable changes.\n\n- Epic #4430 shipped.',
    commitsForFile: () => [],
  });
  assert.strictEqual(ok, true);
  assert.strictEqual(results[0].pass, true);
  assert.match(results[0].reason, /changelog body annotation/);
});

test('runFreshnessGate: non-changelog doc updated by an Epic-referencing commit still passes', () => {
  const { ok, results } = runFreshnessGate({
    epicId: 4430,
    docs: ['docs/architecture.md'],
    readFileImpl: () => 'No epic annotation in this body at all.',
    commitsForFile: () => ['deadbeefcafe'],
  });
  assert.strictEqual(ok, true);
  assert.strictEqual(results[0].pass, true);
  assert.match(results[0].reason, /commit.*#4430/);
});
