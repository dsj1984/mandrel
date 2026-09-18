import fs from 'node:fs';
import path from 'node:path';

/**
 * Read doc files relative to `docsRoot`, in input order; missing or
 * unreadable files are skipped.
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
