import fs from 'node:fs';
import path from 'node:path';
import { getPaths } from '../config-resolver.js';
import { Logger } from '../Logger.js';
import { applyBudget } from './planning-context-budget.js';

async function readDocsFromRoot(docsRoot, settings) {
  const explicit =
    Array.isArray(settings.docsContextFiles) &&
    settings.docsContextFiles.length > 0;
  const usedFallback = !explicit;
  let targetFiles;
  if (explicit) {
    targetFiles = settings.docsContextFiles.map((f) => ({
      name: f,
      full: path.join(docsRoot, f),
    }));
  } else {
    const entries = fs.readdirSync(docsRoot, { withFileTypes: true });
    targetFiles = entries
      .filter((e) => e.isFile() && e.name.endsWith('.md'))
      .map((e) => ({ name: e.name, full: path.join(docsRoot, e.name) }));
  }

  const reads = targetFiles.map(async ({ name, full }) => {
    try {
      const stat = await fs.promises.stat(full);
      if (!stat.isFile()) return null;
      const content = await fs.promises.readFile(full, 'utf-8');
      return { name, path: name, content };
    } catch (_e) {
      return null;
    }
  });

  const docs = (await Promise.all(reads)).filter(Boolean);
  return { docs, usedFallback };
}

/**
 * Read project documentation, returning raw doc objects so callers can apply
 * the planning-context budget themselves. Each entry is `{ name, path,
 * content }`. The legacy single-string concatenation is no longer the public
 * surface — use {@link buildDocsContext} when an envelope-shaped value is
 * needed.
 *
 * @param {object} settings — Resolved config bag (`project.paths.docsRoot`,
 *   `project.docsContextFiles`) or legacy-shim view (same shape).
 * @returns {Promise<{ docs: Array<{name: string, path: string, content: string}>, usedFallback: boolean }>}
 */
export async function scrapeProjectDocs(settings) {
  // `settings` is the legacy-shim view (`{ paths, docsContextFiles, ... }`)
  // OR the post-reshape canonical (`{ project: { paths, ... } }`). Under the
  // resolver shim `agentSettings.paths === project.paths`, so re-wrap to the
  // canonical shape `getPaths` consumes.
  const docsRoot = getPaths({
    project: { paths: settings?.project?.paths ?? settings?.paths },
  }).docsRoot;
  if (!docsRoot || !fs.existsSync(docsRoot)) {
    return { docs: [], usedFallback: false };
  }
  Logger.info(`[Epic Planner] Scraping project docs from ${docsRoot}...`);
  try {
    const result = await readDocsFromRoot(docsRoot, settings);
    if (result.usedFallback) {
      Logger.warn(
        '[Epic Planner] ⚠️  project.docsContextFiles is unset — falling back to every top-level *.md under docsRoot. Configure docsContextFiles for production planning.',
      );
    }
    return result;
  } catch (err) {
    Logger.warn(
      `[Epic Planner] Warning: Failed to read docsRoot: ${err.message}`,
    );
    return { docs: [], usedFallback: false };
  }
}

/**
 * Build the `docsContext` value emitted in `--emit-context` envelopes.
 * Reads the docs and applies the planning-context budget so over-budget
 * payloads downgrade to summary mode automatically. Callers pass
 * `{ fullContext: true }` to honour the `--full-context` CLI opt-in.
 *
 * @param {object} settings — Resolved config bag (same shape as `scrapeProjectDocs`).
 * @param {{ maxBytes?: number, summaryMode?: 'auto'|'always'|'never' }} [planningLimits]
 * @param {{ fullContext?: boolean }} [opts]
 * @returns {Promise<{ mode: 'full'|'summary', items: Array<object>, totalBytes: number, usedFallback: boolean }>}
 */
export async function buildDocsContext(settings, planningLimits, opts = {}) {
  const { docs, usedFallback } = await scrapeProjectDocs(settings);
  const budgeted = applyBudget(docs, planningLimits, opts);
  return { ...budgeted, usedFallback };
}
