import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  FILE_READ_CAP,
  isTemplatePath,
  scanForConflicts,
  TEMPLATE_PATH_PREFIXES,
} from '../.agents/scripts/detect-merges.js';

const MARKED = '<<<<<<< HEAD\nfoo\n=======\nbar\n>>>>>>> other\n';

function makeRepo() {
  const root = mkdtempSync(join(tmpdir(), 'detect-merges-'));
  mkdirSync(join(root, '.agents/workflows'), { recursive: true });
  mkdirSync(join(root, 'src'), { recursive: true });
  return root;
}

test('detect-merges', async (t) => {
  await t.test(
    'TEMPLATE_PATH_PREFIXES includes the workflow template dir',
    () => {
      assert.ok(TEMPLATE_PATH_PREFIXES.includes('.agents/workflows/'));
    },
  );

  await t.test('isTemplatePath matches workflow files by prefix', () => {
    assert.equal(isTemplatePath('.agents/workflows/git-merge-pr.md'), true);
    assert.equal(isTemplatePath('.agents/workflows/nested/x.md'), true);
    assert.equal(isTemplatePath('src/foo.js'), false);
  });

  await t.test(
    'workflow template containing conflict markers does NOT flag',
    async () => {
      const root = makeRepo();
      try {
        const file = '.agents/workflows/git-merge-pr.md';
        writeFileSync(join(root, file), MARKED);
        const hits = await scanForConflicts([file], root);
        assert.deepEqual(hits, []);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  await t.test(
    'non-template file with the same markers still flags',
    async () => {
      const root = makeRepo();
      try {
        const file = 'src/broken.js';
        writeFileSync(join(root, file), MARKED);
        const hits = await scanForConflicts([file], root);
        assert.equal(hits.length, 1);
        assert.equal(hits[0].file, file);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  await t.test('FILE_READ_CAP is exactly 64', () => {
    assert.equal(FILE_READ_CAP, 64);
  });

  await t.test(
    'scanForConflicts caps concurrent fs reads at FILE_READ_CAP',
    async () => {
      // Stub `scanForConflicts` by patching the readFile chain via a custom
      // file set: we monkey-patch fs.promises.readFile within this test's
      // scope by intercepting the only thing scanForConflicts touches —
      // a freshly built repo. We measure max in-flight by wrapping readFile.
      const root = makeRepo();
      try {
        const N = 200; // > FILE_READ_CAP, so cap must throttle
        const files = [];
        for (let i = 0; i < N; i++) {
          const f = `src/file-${String(i).padStart(4, '0')}.js`;
          files.push(f);
          // Half are MARKED, half are clean — exercises both code paths.
          writeFileSync(
            join(root, f),
            i % 2 === 0 ? MARKED : '// clean file\n',
          );
        }

        // Patch readFile to track concurrency. The original readFile is
        // restored in the finally block below.
        const fsPromises = await import('node:fs');
        const original = fsPromises.default.promises.readFile;
        let inFlight = 0;
        let maxInFlight = 0;
        fsPromises.default.promises.readFile = async (...args) => {
          inFlight++;
          if (inFlight > maxInFlight) maxInFlight = inFlight;
          try {
            // Yield so the scheduler interleaves multiple readers before any
            // resolves — this is what surfaces a too-high concurrency cap.
            await new Promise((r) => setImmediate(r));
            return await original(...args);
          } finally {
            inFlight--;
          }
        };
        try {
          const hits = await scanForConflicts(files, root);
          assert.ok(
            maxInFlight <= FILE_READ_CAP,
            `expected maxInFlight <= ${FILE_READ_CAP}, saw ${maxInFlight}`,
          );
          // Sanity: every other file flagged.
          assert.equal(hits.length, N / 2);
        } finally {
          fsPromises.default.promises.readFile = original;
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  await t.test(
    'scanForConflicts produces deterministic output across runs and input orderings',
    async () => {
      const root = makeRepo();
      try {
        const names = ['src/a.js', 'src/b.js', 'src/c.js', 'src/d.js'];
        for (const f of names) writeFileSync(join(root, f), MARKED);

        const run1 = await scanForConflicts([...names], root);
        const run2 = await scanForConflicts([...names], root);
        // Same input, same output (byte-stable serialization).
        assert.equal(JSON.stringify(run1), JSON.stringify(run2));

        // Reverse the input order — output must still be sorted ascending.
        const run3 = await scanForConflicts([...names].reverse(), root);
        assert.equal(JSON.stringify(run1), JSON.stringify(run3));

        // Verify ascending file ordering.
        const filesOut = run1.map((h) => h.file);
        const sorted = [...filesOut].sort();
        assert.deepEqual(filesOut, sorted);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});
