/* node:coverage ignore file -- pre-push conflict-marker scanner; pure I/O glue over `git ls-files` */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { runAsCli } from './lib/cli-utils.js';
import { Logger } from './lib/Logger.js';
import { concurrentMap } from './lib/util/concurrent-map.js';

// Paths under these prefixes are treated as template/documentation files
// that may legitimately contain literal conflict-marker strings (e.g. the
// merge-conflict runbook). Paths use forward slashes to match `git ls-files`.
export const TEMPLATE_PATH_PREFIXES = ['.agents/workflows/'];

// Standard git conflict markers. The leading '\n' on '=======' avoids
// matching plain separator lines.
const CONFLICT_MARKERS = ['<<<<<<< ', '\n=======', '>>>>>>> '];

const SELF_PATH = '.agents/scripts/detect-merges.js';

// Test fixtures for detect-merges itself embed literal conflict-marker strings
// to exercise the scanner. Matches any file named `detect-merges*.js` (including
// `.test.js`) under any depth below `tests/`.
const TEST_FIXTURE_PATTERN = /(^|\/)tests\/(?:[^/]+\/)*detect-merges[^/]*\.js$/;

// Cap concurrent `fs.readFile` calls. Unbounded `Promise.all` over every
// tracked file blows past EMFILE on large repos and starves the event loop;
// 64 keeps the kernel happy while still saturating typical SSDs.
export const FILE_READ_CAP = 64;

export function isTemplatePath(file) {
  return TEMPLATE_PATH_PREFIXES.some((prefix) => file.startsWith(prefix));
}

function isDetectMergesTestFixture(file) {
  return TEST_FIXTURE_PATTERN.test(file);
}

/**
 * Scan the given files for conflict markers, skipping templates and self.
 *
 * @param {string[]} files - Repo-relative paths (forward slashes).
 * @param {string}   root  - Repo root used to resolve file paths.
 * @returns {Promise<Array<{ file: string, marker: string }>>}
 */
export async function scanForConflicts(files, root) {
  const mapped = await concurrentMap(
    files,
    async (file) => {
      if (
        file === SELF_PATH ||
        isTemplatePath(file) ||
        isDetectMergesTestFixture(file)
      ) {
        return null;
      }
      try {
        const content = await fs.promises.readFile(
          path.join(root, file),
          'utf8',
        );
        for (const marker of CONFLICT_MARKERS) {
          if (content.includes(marker)) {
            return { file, marker };
          }
        }
        return null;
      } catch (_readErr) {
        // Ignore unreadable files (binaries, broken symlinks, etc.).
        return null;
      }
    },
    { concurrency: FILE_READ_CAP },
  );
  // `concurrentMap` preserves input order, so filtering yields a hit list in
  // the same order as `files`. Sort by file for byte-stable output regardless
  // of caller-supplied ordering.
  const hits = mapped.filter((hit) => hit !== null);
  hits.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  return hits;
}

export async function main() {
  try {
    const root = process.cwd();
    const filesOutput = execFileSync('git', ['ls-files'], {
      cwd: root,
    }).toString();
    const files = filesOutput.split('\n').filter(Boolean);

    const hits = await scanForConflicts(files, root);

    if (hits.length > 0) {
      for (const { file, marker } of hits) {
        Logger.error(
          `Conflict marker '${marker.trim()}' found in tracked file: ${file}`,
        );
      }
      throw new Error(
        '\nERROR: Merge conflicts detected. Please resolve them before proceeding.',
      );
    } else {
      Logger.info('No conflict markers found in tracked files.');
      process.exit(0);
    }
  } catch (err) {
    throw new Error(`Error detecting merges: ${err.message}`);
  }
}

runAsCli(import.meta.url, main, { source: 'detect-merges' });
