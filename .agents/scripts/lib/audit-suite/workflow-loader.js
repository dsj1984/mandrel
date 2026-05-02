/**
 * lib/audit-suite/workflow-loader.js — Filesystem IO for audit workflows.
 *
 * Extracted from `.agents/scripts/run-audit-suite.js` (Story #963, Epic #946).
 *
 * The runner injects either {@link loadWorkflow} (production) or a stub (tests)
 * via `injectedLoadWorkflow`. Same for {@link defaultWriteArtifact} and
 * `injectedWriteArtifact`. Keeping the IO bound here lets the runner module
 * stay free of `node:fs` imports and stay easy to unit-test.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Read an audit workflow markdown file. Returns `null` when the file is
 * missing — the runner converts that into a `low`-severity finding rather
 * than throwing, so a missing workflow doesn't fail the suite.
 *
 * @param {string} auditName
 * @param {string} workflowsDir absolute path to the workflows root
 * @returns {Promise<{ path: string, content: string } | null>}
 */
export async function loadWorkflow(auditName, workflowsDir) {
  const workflowPath = path.join(workflowsDir, `${auditName}.md`);
  try {
    const content = await fs.readFile(workflowPath, 'utf8');
    return { path: workflowPath, content };
  } catch {
    return null;
  }
}

/**
 * Default artifact writer used when the caller passes a `--run-id` /
 * `artifactPrefix`. Creates the artifacts dir on demand and returns the
 * absolute path of the file written.
 *
 * @param {string} artifactsDir
 * @param {string} fileName
 * @param {string} content
 * @returns {Promise<string>}
 */
export async function defaultWriteArtifact(artifactsDir, fileName, content) {
  await fs.mkdir(artifactsDir, { recursive: true });
  const fullPath = path.join(artifactsDir, fileName);
  await fs.writeFile(fullPath, content, 'utf8');
  return fullPath;
}
