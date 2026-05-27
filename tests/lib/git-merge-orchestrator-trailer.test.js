import assert from 'node:assert/strict';
import test from 'node:test';

import { buildAutoResolveTrailer } from '../../.agents/scripts/lib/git-merge-orchestrator.js';

/**
 * Contract: every line of the generated message (header, body, trailers)
 * stays within commitlint's per-line caps for body and footer. The cap
 * regression that motivated Story #3160 produced footer lines like
 *
 *   Auto-resolved-file: baselines/crap.json (discarded 13305 base line(s))
 *
 * which busted the 100-char `footer-max-line-length` default in
 * `@commitlint/config-conventional` and rejected the auto-resolution merge
 * commit deterministically during `story-close`.
 */

const MAX = 100;

function lines(message) {
  return message.split('\n');
}

test('buildAutoResolveTrailer: typical case keeps every line within cap', () => {
  const message = buildAutoResolveTrailer([
    { file: 'baselines/crap.json', discardedLines: 13305 },
    { file: 'baselines/maintainability.json', discardedLines: 4210 },
  ]);
  for (const line of lines(message)) {
    assert.ok(
      line.length <= MAX,
      `line exceeds ${MAX} chars (${line.length}): "${line}"`,
    );
  }
});

test('buildAutoResolveTrailer: emits one Auto-resolved-file trailer per file with no count on the footer line', () => {
  const message = buildAutoResolveTrailer([
    { file: 'baselines/crap.json', discardedLines: 13305 },
    { file: 'baselines/maintainability.json', discardedLines: 4210 },
  ]);
  const trailerLines = lines(message).filter((l) =>
    l.startsWith('Auto-resolved-file:'),
  );
  assert.equal(trailerLines.length, 2);
  for (const line of trailerLines) {
    assert.ok(
      !/discarded/.test(line),
      `trailer line must not carry the discarded-line count: "${line}"`,
    );
    assert.ok(
      !/\(.*\)/.test(line),
      `trailer line must not carry a parenthetical: "${line}"`,
    );
  }
});

test('buildAutoResolveTrailer: discarded-line counts are reported in body prose', () => {
  const message = buildAutoResolveTrailer([
    { file: 'baselines/crap.json', discardedLines: 13305 },
  ]);
  assert.match(message, /discarded 13305 base line\(s\)/);
});

test('buildAutoResolveTrailer: pathological long path + huge discard count still fits', () => {
  const longPath =
    'packages/very/deeply/nested/sub/sub/sub/sub/module/with/quite-a-long-baseline-file-name.json';
  const message = buildAutoResolveTrailer([
    { file: longPath, discardedLines: 9_999_999 },
  ]);
  for (const line of lines(message)) {
    assert.ok(
      line.length <= MAX,
      `line exceeds ${MAX} chars (${line.length}): "${line}"`,
    );
  }
  // The trailer still names the file (possibly middle-truncated with an
  // ellipsis), but the `Auto-resolved-file:` key is present.
  assert.match(message, /Auto-resolved-file: /);
});

test('buildAutoResolveTrailer: pathological many-file batch all stay within cap', () => {
  const resolved = Array.from({ length: 25 }, (_, i) => ({
    file: `baselines/very-long-baseline-${i.toString().padStart(4, '0')}.json`,
    discardedLines: 100_000 + i,
  }));
  const message = buildAutoResolveTrailer(resolved);
  for (const line of lines(message)) {
    assert.ok(
      line.length <= MAX,
      `line exceeds ${MAX} chars (${line.length}): "${line}"`,
    );
  }
});

test('buildAutoResolveTrailer: respects an explicit smaller cap on body + trailer lines', () => {
  const message = buildAutoResolveTrailer(
    [{ file: 'a/b/c/very-long-filename.json', discardedLines: 1234567 }],
    { maxLineLength: 80 },
  );
  // The cap governs the generated body and trailer lines; the static
  // header sentence is a fixed announcement that callers compose around.
  const generated = lines(message).filter(
    (l) => l.startsWith('- ') || l.startsWith('Auto-resolved-file:'),
  );
  for (const line of generated) {
    assert.ok(
      line.length <= 80,
      `generated line exceeds 80 chars (${line.length}): "${line}"`,
    );
  }
});
