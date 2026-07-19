/**
 * tests/audit-suite/dispatch-checklist.test.js — unit test for the
 * deliver-dispatch checklist builder (Story #4627, AC-2).
 *
 * Pins the write-time checklist threading call site: the deliver dispatch
 * derives a footprint from the Story's `changes[]` / `references[]` entries,
 * assembles the footprint-matched local-lens checklist payload, writes it to
 * the run temp dir, and returns the `checklistPath` the spawned Story worker
 * receives. An empty match writes nothing and threads a null path.
 *
 * Imported from the audit-suite barrel — the same entry point the deliver
 * dispatch (`helpers/deliver-story.md`) imports — so this is a real consumer of
 * the public export, not a colocated project file.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { buildDispatchChecklist } from '../../.agents/scripts/lib/audit-suite/index.js';

/** A payload-builder spy that records the footprint it received. */
function payloadSpy(returnValue) {
  const calls = [];
  const fn = (args) => {
    calls.push(args);
    return returnValue;
  };
  fn.calls = calls;
  return fn;
}

const nonEmptyPayload = {
  payload: '# checklist\n\n- do the thing',
  includedLenses: ['clean-code'],
  droppedLenses: [],
  matchedLenses: ['clean-code'],
  estimatedTokens: 5,
  tokenBudget: 4000,
};

const emptyPayload = {
  payload: '',
  includedLenses: [],
  droppedLenses: [],
  matchedLenses: [],
  estimatedTokens: 0,
  tokenBudget: 4000,
};

test('derives the footprint as the union of changes[] and references[] path entries', () => {
  const buildPayloadFn = payloadSpy(emptyPayload);
  buildDispatchChecklist({
    storyId: 4627,
    changes: [
      { path: '.agents/scripts/a.js', assumption: 'x' },
      { path: '  .agents/scripts/b.js  ' },
    ],
    references: [{ path: '.agents/scripts/lib/c.js' }, 'bare/string.js'],
    runTempDir: 'temp/run-abc',
    buildPayloadFn,
    writeFileFn: () => {},
  });
  assert.deepEqual(buildPayloadFn.calls[0].footprint, [
    '.agents/scripts/a.js',
    '.agents/scripts/b.js',
    '.agents/scripts/lib/c.js',
    'bare/string.js',
  ]);
});

test('drops empty / non-string / missing footprint entries', () => {
  const buildPayloadFn = payloadSpy(emptyPayload);
  buildDispatchChecklist({
    storyId: 4627,
    changes: [{ path: '' }, { path: '   ' }, { assumption: 'no path' }, 42],
    references: null,
    runTempDir: 'temp/run-abc',
    buildPayloadFn,
    writeFileFn: () => {},
  });
  assert.deepEqual(buildPayloadFn.calls[0].footprint, []);
});

test('writes the payload to <runTempDir>/story-<id>-checklist.md and returns the path', () => {
  const writes = [];
  const out = buildDispatchChecklist({
    storyId: 4627,
    changes: [{ path: '.agents/scripts/x.js' }],
    references: [],
    runTempDir: 'temp/run-abc',
    buildPayloadFn: payloadSpy(nonEmptyPayload),
    writeFileFn: (filePath, content) => writes.push({ filePath, content }),
  });

  assert.equal(
    out.checklistPath,
    path.join('temp/run-abc', 'story-4627-checklist.md'),
  );
  assert.equal(out.skipped, false);
  assert.deepEqual(out.includedLenses, ['clean-code']);
  assert.equal(writes.length, 1);
  assert.equal(
    writes[0].filePath,
    path.join('temp/run-abc', 'story-4627-checklist.md'),
  );
  assert.equal(writes[0].content, '# checklist\n\n- do the thing');
});

test('threads a null checklistPath and writes nothing when no lens matched', () => {
  const writes = [];
  const out = buildDispatchChecklist({
    storyId: 4627,
    changes: [{ path: 'docs/unrelated.md' }],
    runTempDir: 'temp/run-abc',
    buildPayloadFn: payloadSpy(emptyPayload),
    writeFileFn: (filePath, content) => writes.push({ filePath, content }),
  });

  assert.equal(out.checklistPath, null);
  assert.equal(out.skipped, true);
  assert.equal(writes.length, 0);
});

test('throws when a non-empty payload has no runTempDir to write to', () => {
  assert.throws(
    () =>
      buildDispatchChecklist({
        storyId: 4627,
        changes: [{ path: '.agents/scripts/x.js' }],
        runTempDir: undefined,
        buildPayloadFn: payloadSpy(nonEmptyPayload),
        writeFileFn: () => {},
      }),
    /runTempDir is required/,
  );
});

test('integration: real payload builder assembles a footprint-matched checklist', () => {
  const writes = [];
  const out = buildDispatchChecklist({
    storyId: 4627,
    // `.agents/scripts/**` matches at least one real LOCAL lens
    // (audit-performance) plus the universal clean-code lens, so the payload is
    // non-empty.
    changes: [{ path: '.agents/scripts/lib/foo.js' }],
    references: [],
    runTempDir: 'temp/run-int',
    writeFileFn: (filePath, content) => writes.push({ filePath, content }),
  });

  assert.equal(
    out.checklistPath,
    path.join('temp/run-int', 'story-4627-checklist.md'),
  );
  assert.equal(out.skipped, false);
  assert.ok(
    out.includedLenses.length >= 1,
    `expected >= 1 matched local lens, got ${JSON.stringify(out.includedLenses)}`,
  );
  assert.equal(writes.length, 1);
  assert.ok(
    writes[0].content.length > 0,
    'the assembled checklist payload must be non-empty',
  );
});
