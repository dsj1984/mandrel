/**
 * import-graph.js — the shared static-import (module) graph, used by the
 * cycle ratchet and the hotspot in-degree ranking so both read one answer.
 * Unrelated to the task DAG in `lib/Graph.js`.
 *
 * @module lib/import-graph
 */

import fs from 'node:fs';
import path from 'node:path';
import { toPosix, walkFiles } from './util/paths.js';

/**
 * The npm-published roots, resolved into one graph so cross-root cycles show.
 *
 * @type {string[]}
 */
export const DEFAULT_ROOTS = [path.join('.agents', 'scripts'), 'bin', 'lib'];

/**
 * @param {string} rootDir
 * @returns {string[]} absolute paths, sorted
 */
export function collectJsFiles(rootDir) {
  return walkFiles(rootDir, {
    skipDirs: ['node_modules'],
    filter: (abs, dirent) => dirent.isFile() && abs.endsWith('.js'),
    onError: () => {},
  }).sort();
}

const IMPORT_RE = /from\s+['"](\.\.?\/[^'"]+\.js)['"]/g;

/**
 * @param {string} source
 * @returns {string[]}
 */
export function parseRelativeImports(source) {
  const specs = [];
  for (const m of source.matchAll(IMPORT_RE)) {
    specs.push(m[1]);
  }
  return specs;
}

/**
 * Posix ids relative to `rootDir` (platform-stable); external edges dropped.
 *
 * @param {string[]} files
 * @param {string} rootDir
 * @param {{ readFile?: (p: string) => string }} [opts]
 * @returns {Map<string, string[]>}
 */
export function buildGraph(files, rootDir, { readFile } = {}) {
  const read = readFile ?? ((p) => fs.readFileSync(p, 'utf-8'));
  const ids = files.map((file) => toPosix(path.relative(rootDir, file)));
  const idSet = new Set(ids);
  const graph = new Map();
  for (const [i, file] of files.entries()) {
    const id = ids[i];
    let source;
    try {
      source = read(file);
    } catch {
      graph.set(id, []);
      continue;
    }
    const edges = [];
    for (const spec of parseRelativeImports(source)) {
      const target = toPosix(
        path.relative(rootDir, path.resolve(path.dirname(file), spec)),
      );
      if (idSet.has(target) && target !== id) edges.push(target);
    }
    graph.set(id, [...new Set(edges)].sort());
  }
  return graph;
}

/**
 * `null` when no root exists — callers must not treat that as an edgeless
 * graph.
 *
 * @param {string} cwd
 * @param {{ roots?: string[] }} [opts]
 * @returns {Map<string, string[]> | null}
 */
export function resolveRepoGraph(cwd, { roots = DEFAULT_ROOTS } = {}) {
  const present = roots
    .map((dir) => path.resolve(cwd, dir))
    .filter((dir) => fs.existsSync(dir));
  if (present.length === 0) return null;
  const files = present.flatMap((dir) => collectJsFiles(dir));
  if (files.length === 0) return null;
  return buildGraph(files, path.resolve(cwd));
}

/**
 * Every node is present (0 when nothing imports it).
 *
 * @param {Map<string, string[]> | null} graph
 * @returns {Map<string, number>} empty when `graph` is null
 */
export function computeInDegree(graph) {
  const degrees = new Map();
  if (!graph) return degrees;
  for (const node of graph.keys()) degrees.set(node, 0);
  for (const edges of graph.values()) {
    for (const target of edges) {
      degrees.set(target, (degrees.get(target) ?? 0) + 1);
    }
  }
  return degrees;
}
