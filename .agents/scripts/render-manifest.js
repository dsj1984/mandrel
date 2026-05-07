#!/usr/bin/env node

/**
 * .agents/scripts/render-manifest.js — Derived-view Manifest Renderer
 *
 * Regenerates `temp/epic-<epicId>/manifest.{md,json}` from the
 * `dispatch-manifest` structured comment on the Epic (Epic #1030 Story
 * #1040 / Task #1054 — migrated from the legacy flat
 * `temp/dispatch-manifest-<epicId>.{md,json}` layout). The comment is
 * the single source of truth for which Stories the sprint committed to;
 * the per-Epic files are a convenience view that lets wave-gate runs,
 * local tooling, and CI consumers work offline.
 *
 * Running this script never mutates GitHub state — it only performs a read
 * of the existing comment and writes the derived artefacts under the
 * per-Epic tree.
 *
 * Usage:
 *   node .agents/scripts/render-manifest.js --epic <EPIC_ID>
 *
 * Exit codes:
 *   0 — render succeeded.
 *   1 — no manifest comment (or no parseable JSON) on the Epic.
 *   2 — configuration or provider transport error.
 */

import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { runAsCli } from './lib/cli-utils.js';
import { epicArtifactPath } from './lib/config/temp-paths.js';
import { PROJECT_ROOT, resolveConfig } from './lib/config-resolver.js';
import { Logger } from './lib/Logger.js';
import { findStructuredComment } from './lib/orchestration/ticketing.js';
import { atomicWrite } from './lib/presentation/manifest-persistence.js';
import { createProvider } from './lib/provider-factory.js';

export function extractManifestJson(body) {
  if (typeof body !== 'string') return null;
  const fence = body.match(/```json\s*\n([\s\S]*?)\n```/);
  if (!fence) return null;
  try {
    return JSON.parse(fence[1]);
  } catch {
    return null;
  }
}

/**
 * Write the rendered manifest files. Separated from the I/O boundary so
 * tests can exercise the pure contract without touching disk.
 *
 * @param {{ epicId: number, body: string, parsed: object, projectRoot?: string }} opts
 * @returns {{ mdPath: string, jsonPath: string }}
 */
export function writeRenderedManifest({
  epicId,
  body,
  parsed,
  projectRoot = PROJECT_ROOT,
  config,
}) {
  // Per-Epic layout (Epic #1030 Story #1040): write under
  // `<projectRoot>/temp/epic-<eid>/manifest.{md,json}`.
  const relMd = epicArtifactPath(epicId, 'manifest.md', config);
  const relJson = epicArtifactPath(epicId, 'manifest.json', config);
  const mdPath = path.isAbsolute(relMd) ? relMd : path.join(projectRoot, relMd);
  const jsonPath = path.isAbsolute(relJson)
    ? relJson
    : path.join(projectRoot, relJson);
  const epicDir = path.dirname(mdPath);
  if (!fs.existsSync(epicDir)) {
    fs.mkdirSync(epicDir, { recursive: true });
  }
  // Both writes go through the atomic write-then-rename helper so a
  // crash mid-write (rename throws / process killed) leaves either the
  // pre-existing artefact intact or no file at all — never a partial
  // truncation. The `.tmp` residue is best-effort removed on failure
  // (see `atomicWrite` in manifest-persistence.js).
  atomicWrite(mdPath, body);
  atomicWrite(jsonPath, `${JSON.stringify(parsed, null, 2)}\n`);
  return { mdPath, jsonPath };
}

export async function renderManifestFromComment({
  epicId,
  injectedProvider,
} = {}) {
  if (!epicId || Number.isNaN(epicId) || epicId <= 0) {
    Logger.fatal('Usage: node render-manifest.js --epic <EPIC_ID>');
  }

  const { orchestration } = resolveConfig();
  const provider = injectedProvider || createProvider(orchestration);

  const comment = await findStructuredComment(
    provider,
    epicId,
    'dispatch-manifest',
  );
  if (!comment) {
    console.error(
      `[render-manifest] No dispatch-manifest comment on Epic #${epicId}. ` +
        `Run the dispatcher (\`node .agents/scripts/dispatcher.js ${epicId}\`) first.`,
    );
    process.exit(1);
  }

  const parsed = extractManifestJson(comment.body);
  if (!parsed) {
    console.error(
      `[render-manifest] dispatch-manifest comment #${comment.id} on Epic #${epicId} did not contain a parseable JSON block.`,
    );
    process.exit(1);
  }

  const { mdPath, jsonPath } = writeRenderedManifest({
    epicId,
    body: comment.body,
    parsed,
  });

  const storyCount = Array.isArray(parsed.stories) ? parsed.stories.length : 0;
  console.log(
    `[render-manifest] ✅ Rendered ${storyCount} story(ies) for Epic #${epicId}:\n` +
      `  - ${mdPath}\n` +
      `  - ${jsonPath}`,
  );
  return { mdPath, jsonPath, stories: storyCount };
}

async function main() {
  const { values } = parseArgs({
    options: { epic: { type: 'string' } },
    strict: false,
  });
  const epicId = Number.parseInt(values.epic ?? '', 10);
  await renderManifestFromComment({ epicId });
}

runAsCli(import.meta.url, main, { source: 'render-manifest' });
