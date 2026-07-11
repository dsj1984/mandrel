import fs from 'node:fs';
import path from 'node:path';

/**
 * Read an explicit list of doc files relative to `docsRoot`, returning one
 * `{ name, path, content }` object per file that exists and reads cleanly.
 * Missing or unreadable files are skipped silently. Order is preserved from
 * the input list. This is the shared read/normalize seam the per-Epic docs
 * digest builds on (Story #4338) so there is a single home for the fs read
 * path.
 *
 * @param {{ files: string[], docsRoot?: string }} args
 * @returns {Promise<Array<{ name: string, path: string, content: string }>>}
 */
export async function readDocFiles({ files, docsRoot } = {}) {
  const list = Array.isArray(files) ? files : [];
  const root =
    typeof docsRoot === 'string' && docsRoot.length > 0 ? docsRoot : '.';
  const reads = list.map(async (name) => {
    const full = path.join(root, name);
    try {
      const stat = await fs.promises.stat(full);
      if (!stat.isFile()) return null;
      const content = await fs.promises.readFile(full, 'utf-8');
      return { name, path: name, content };
    } catch (_e) {
      return null;
    }
  });
  return (await Promise.all(reads)).filter(Boolean);
}
