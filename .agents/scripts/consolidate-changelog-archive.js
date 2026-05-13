#!/usr/bin/env node
/**
 * One-shot consolidator for Story #1605 (Epic #1184, v6.0.0 cut).
 *
 * Merges into a single chronologically ordered archive
 * (newest → oldest, matching the existing Keep-a-Changelog convention):
 *
 *   1. The 5.x history currently embedded in the live `docs/CHANGELOG.md`
 *      (everything from the first `## [5.x.y]` header through to — but not
 *      including — the trailing "Earlier releases" pointer footer).
 *   2. `docs/archive/CHANGELOG-5.0-5.29.md` entries.
 *   3. `docs/archive/CHANGELOG-v4.md` entries.
 *
 * Output: `docs/archive/CHANGELOG-pre-v6.md`.
 *
 * Side effects:
 *   - Resets `docs/CHANGELOG.md` to header + Unreleased block (the in-flight
 *     v6 entry). All 5.x sections and the "Earlier releases" footer are
 *     removed.
 *   - Deletes the three source archive files (5.x history, 5.0–5.29 archive,
 *     v4 archive).
 *   - Re-runnable: re-running on an already-consolidated tree is a no-op
 *     with a friendly "already consolidated" message.
 *
 * This script is intentionally one-shot. Per the tech spec, it is removed at
 * Epic #1184 close.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Logger } from './lib/Logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..', '..');
const liveChangelogPath = path.join(repoRoot, 'docs', 'CHANGELOG.md');
const archive5xPath = path.join(
  repoRoot,
  'docs',
  'archive',
  'CHANGELOG-5.0-5.29.md',
);
const archiveV4Path = path.join(repoRoot, 'docs', 'archive', 'CHANGELOG-v4.md');
const consolidatedPath = path.join(
  repoRoot,
  'docs',
  'archive',
  'CHANGELOG-pre-v6.md',
);

function readIfExists(p) {
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
}

/**
 * Extract the 5.x history slice from the live `docs/CHANGELOG.md`.
 *
 * The live file holds, in order:
 *   1. `# Changelog` header + intro.
 *   2. `## [Unreleased]` block (the in-flight v6 entry).
 *   3. One or more `## [5.x.y] — DATE` sections.
 *   4. A trailing `## Earlier releases (...)` pointer block.
 *
 * Returns:
 *   - `head` — the file prefix from start through the end of the
 *     `## [Unreleased]` block (this stays in the live file post-reset).
 *   - `fiveHistory` — the concatenated 5.x section text (this is consolidated).
 *   - `tailFooter` — the trailing "Earlier releases" pointer block (discarded;
 *     the consolidated archive supersedes it).
 */
function sliceLiveChangelog(text) {
  const lines = text.split(/\r?\n/);

  const firstFiveIdx = lines.findIndex((line) =>
    /^##\s+\[5\.\d+\.\d+\]/.test(line),
  );
  if (firstFiveIdx === -1) {
    return {
      head: text,
      fiveHistory: '',
      tailFooter: '',
      alreadyConsolidated: true,
    };
  }

  const earlierIdx = lines.findIndex((line) =>
    /^##\s+Earlier releases/.test(line),
  );
  const fiveEndExclusive = earlierIdx === -1 ? lines.length : earlierIdx;

  // The body has a `---` separator line just before the "Earlier releases"
  // pointer; trim it off the 5.x slice so the consolidated archive doesn't
  // carry a dangling horizontal rule.
  let fiveSliceEnd = fiveEndExclusive;
  while (
    fiveSliceEnd > firstFiveIdx &&
    /^(\s*|---)\s*$/.test(lines[fiveSliceEnd - 1])
  ) {
    fiveSliceEnd -= 1;
  }

  // Head ends just before the first 5.x header. Strip trailing blank lines
  // so the rebuilt live file ends with exactly one newline at EOF.
  let headEnd = firstFiveIdx;
  while (headEnd > 0 && lines[headEnd - 1].trim() === '') {
    headEnd -= 1;
  }

  const head = `${lines.slice(0, headEnd).join('\n')}\n`;
  const fiveHistory = `${lines.slice(firstFiveIdx, fiveSliceEnd).join('\n')}\n`;
  const tailFooter =
    earlierIdx === -1 ? '' : `${lines.slice(earlierIdx).join('\n')}\n`;

  return { head, fiveHistory, tailFooter, alreadyConsolidated: false };
}

/**
 * Strip the leading `# Title` heading + intro prelude from an archive file
 * so it can be concatenated under the consolidated archive's own H1 without
 * duplicate top-level headings. The first `## [x.y.z]` heading marks the
 * start of the entry stream.
 */
function stripArchivePrelude(text) {
  if (!text) {
    return '';
  }
  const m = text.match(/^##\s+\[/m);
  if (!m) {
    return text.trimStart();
  }
  return text.slice(m.index);
}

function buildConsolidated({ fiveHistory, archive5x, archiveV4 }) {
  const header = [
    '# Changelog Archive — pre-v6 (v1.x – v5.41.x)',
    '',
    'Consolidated archive of every changelog entry that predates the v6.0.0',
    'cut. Three sources were merged here at Epic #1184 close:',
    '',
    '1. The 5.30.x – 5.41.x history that previously lived in `docs/CHANGELOG.md`.',
    '2. The 5.0.0 – 5.29.0 history from `docs/archive/CHANGELOG-5.0-5.29.md`.',
    '3. The 1.x – 4.x history from `docs/archive/CHANGELOG-v4.md`.',
    '',
    'Entries are listed newest → oldest, matching the Keep-a-Changelog',
    'convention used by `docs/CHANGELOG.md`. The active changelog —',
    'starting at v6.0.0 — is [`../CHANGELOG.md`](../CHANGELOG.md).',
    '',
    '---',
    '',
    '',
  ].join('\n');

  // The 5.x history slice already starts at a `## [5.x.y]` header — no
  // prelude stripping needed there.
  const parts = [
    header,
    fiveHistory.trimEnd(),
    '\n\n',
    stripArchivePrelude(archive5x).trimEnd(),
    '\n\n',
    stripArchivePrelude(archiveV4).trimEnd(),
    '\n',
  ];

  return parts.join('');
}

function rebuildLiveChangelog(head) {
  // Ensure trailing newline and a single blank line after the Unreleased
  // block for cleanliness — operators will append the cut v6 entry below it
  // when the release is tagged.
  return head.replace(/\n+$/, '\n');
}

function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');

  const liveText = readIfExists(liveChangelogPath);
  if (!liveText) {
    Logger.error(
      `[consolidate-changelog-archive] FATAL: ${liveChangelogPath} not found.`,
    );
    process.exit(2);
  }

  const { head, fiveHistory, alreadyConsolidated } =
    sliceLiveChangelog(liveText);

  const archive5xText = readIfExists(archive5xPath);
  const archiveV4Text = readIfExists(archiveV4Path);
  const consolidatedExists = fs.existsSync(consolidatedPath);

  if (
    alreadyConsolidated &&
    !archive5xText &&
    !archiveV4Text &&
    consolidatedExists
  ) {
    Logger.info(
      '[consolidate-changelog-archive] Already consolidated — no-op.',
    );
    return;
  }

  if (!archive5xText) {
    Logger.error(
      `[consolidate-changelog-archive] FATAL: ${archive5xPath} missing (already deleted?).`,
    );
    process.exit(2);
  }
  if (!archiveV4Text) {
    Logger.error(
      `[consolidate-changelog-archive] FATAL: ${archiveV4Path} missing (already deleted?).`,
    );
    process.exit(2);
  }

  const consolidated = buildConsolidated({
    fiveHistory,
    archive5x: archive5xText,
    archiveV4: archiveV4Text,
  });

  const newLive = rebuildLiveChangelog(head);

  if (dryRun) {
    Logger.info('[consolidate-changelog-archive] --dry-run');
    Logger.info(
      `  would write    ${consolidatedPath}  (${consolidated.length} bytes)`,
    );
    Logger.info(
      `  would rewrite  ${liveChangelogPath}  (${newLive.length} bytes)`,
    );
    Logger.info(`  would delete   ${archive5xPath}`);
    Logger.info(`  would delete   ${archiveV4Path}`);
    return;
  }

  fs.writeFileSync(consolidatedPath, consolidated, 'utf8');
  fs.writeFileSync(liveChangelogPath, newLive, 'utf8');
  fs.rmSync(archive5xPath, { force: true });
  fs.rmSync(archiveV4Path, { force: true });

  Logger.info('[consolidate-changelog-archive] consolidated:');
  Logger.info(
    `  wrote     ${path.relative(repoRoot, consolidatedPath)}  (${consolidated.length} bytes)`,
  );
  Logger.info(
    `  rewrote   ${path.relative(repoRoot, liveChangelogPath)}  (${newLive.length} bytes)`,
  );
  Logger.info(`  deleted   ${path.relative(repoRoot, archive5xPath)}`);
  Logger.info(`  deleted   ${path.relative(repoRoot, archiveV4Path)}`);
}

// cli-opt-out: one-shot consolidator (Story #1605, Epic #1184). Bare main()
// invocation is intentional — the script is removed at Epic #1184 close and
// never imported as a module, so the runAsCli wrapper would be dead weight.
main();
