/**
 * Filesystem IO for audit workflows, kept out of the runner so tests can
 * inject stubs.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * `null` when missing; the runner records a finding rather than failing.
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
