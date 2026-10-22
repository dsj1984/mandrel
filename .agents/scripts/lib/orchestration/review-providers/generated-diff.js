// Generated files reach the reviewer as a stub; their own --check gates hold them.

import { clip } from './claude-verdict.js';

function sectionPath(section) {
  return /^diff --git a\/.+? b\/(.+)$/m.exec(section)?.[1] ?? null;
}

function generatedPaths(paths, { cwd, gitSpawnFn }) {
  const generated = new Set();
  if (paths.length === 0) return generated;
  const result = gitSpawnFn(
    cwd,
    'check-attr',
    '-z',
    'linguist-generated',
    '--',
    ...paths,
  );
  if (result?.status !== 0) return generated;
  const fields = String(result.stdout ?? '').split('\0');
  for (let i = 0; i + 2 < fields.length; i += 3) {
    if (fields[i + 2] === 'true' || fields[i + 2] === 'set') {
      generated.add(fields[i]);
    }
  }
  return generated;
}

/** A failed attribute lookup leaves the diff whole. */
function omitGeneratedFiles(diff, deps) {
  const sections = diff.split(/(?=^diff --git )/m);
  const generated = generatedPaths(
    sections.map(sectionPath).filter(Boolean),
    deps,
  );
  if (generated.size === 0) return { text: diff, omitted: [] };
  const omitted = [];
  const text = sections
    .map((section) => {
      const file = sectionPath(section);
      if (!file || !generated.has(file)) return section;
      omitted.push(file);
      return `diff --git a/${file} b/${file}\n[generated file: changed, content omitted from review]\n`;
    })
    .join('');
  return { text, omitted };
}

/**
 * @returns {{ reason: string } | { text: string }}
 */
export function readDiff(gitSpawnFn, { baseRef, headRef }, cwd) {
  const range = `${baseRef}...${headRef}`;
  const diff = gitSpawnFn(cwd, 'diff', '--no-color', range);
  if (diff.status === 0)
    return omitGeneratedFiles(diff.stdout, { cwd, gitSpawnFn });
  return {
    reason: `git diff ${range} failed: ${clip(diff.stderr) || '<no output>'}`,
  };
}
