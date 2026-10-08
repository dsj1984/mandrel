/**
 * What the dependency probes compare a pin against: which packages are in the
 * tree at which versions (`present`), and which declared range every dependent
 * asks for (`dependents`). Both come from offline sources only — the lockfile
 * for presence; the npm lockfile or the installed manifests under
 * `node_modules` (including the `.pnpm` store) for dependents' ranges. Either
 * half is `null` when its source is missing, and the probe then says
 * `unknown` rather than guessing.
 *
 * @module lib/audit-exceptions/dependency-index
 */

import fs from 'node:fs';
import path from 'node:path';
import { detectPackageManager } from '../detect-package-manager.js';
import { readJsonc, readText, readYaml } from './read.js';

const DEP_FIELDS = Object.freeze([
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
]);

/** Bounds the installed-manifest walk on a very large tree. */
const MAX_INSTALLED_MANIFESTS = 20000;
const MAX_NESTING = 4;

/** `@scope/name@1.2.3` / `name@npm:^1` → `@scope/name` / `name`. */
export function nameOfSpec(spec) {
  const at = spec.indexOf('@', 1);
  return at === -1 ? spec : spec.slice(0, at);
}

function addTo(map, key, value) {
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(value);
}

function addPresent(present, name, version) {
  if (!present.has(name)) present.set(name, new Set());
  if (typeof version === 'string') present.get(name).add(version);
}

function addDependents(dependents, from, pkg) {
  for (const field of DEP_FIELDS) {
    for (const [name, range] of Object.entries(pkg?.[field] ?? {})) {
      if (typeof range === 'string') addTo(dependents, name, { from, range });
    }
  }
}

function fromPackageLock(lock, present, dependents) {
  for (const [key, entry] of Object.entries(lock?.packages ?? {})) {
    const at = key.lastIndexOf('node_modules/');
    const name =
      at === -1 ? entry?.name : key.slice(at + 'node_modules/'.length);
    if (name) addPresent(present, name, entry?.version);
    addDependents(dependents, key || '(root)', entry);
  }
}

/** pnpm lockfile keys across v5 (`/a/1.0.0`), v6 (`/a@1.0.0`) and v9 (`a@1.0.0(peer)`). */
function parsePnpmKey(key) {
  const bare = key.replace(/^\//, '').replace(/\(.*$/, '');
  const at = bare.lastIndexOf('@');
  if (at > 0) return { name: bare.slice(0, at), version: bare.slice(at + 1) };
  const slash = bare.lastIndexOf('/');
  return slash > 0
    ? { name: bare.slice(0, slash), version: bare.slice(slash + 1) }
    : null;
}

function fromPnpmLock(lock, present) {
  for (const section of ['packages', 'snapshots']) {
    for (const key of Object.keys(lock?.[section] ?? {})) {
      const parsed = parsePnpmKey(key);
      if (parsed) addPresent(present, parsed.name, parsed.version);
    }
  }
}

function fromYarnLock(text, present) {
  let names = [];
  for (const line of text.split('\n')) {
    if (/^[^\s#].*:\s*$/.test(line)) {
      names = line
        .replace(/:\s*$/, '')
        .split(/,\s*/)
        .map((s) => nameOfSpec(s.replace(/^"|"$/g, '')));
      continue;
    }
    const version = /^\s+version:?\s+"?([^"\s]+)"?/.exec(line)?.[1];
    if (version) for (const name of names) addPresent(present, name, version);
  }
}

/**
 * @param {string} root
 * @param {string} pm
 * @returns {Map<string, Set<string>>|null}
 */
/** npm lockfile v1 has no `packages` map: walk its nested `dependencies` tree. */
function fromPackageLockV1(deps, present, dependents) {
  for (const [name, entry] of Object.entries(deps ?? {})) {
    addPresent(present, name, entry?.version);
    addDependents(dependents, `${name}@${entry?.version}`, {
      dependencies: entry?.requires,
    });
    fromPackageLockV1(entry?.dependencies, present, dependents);
  }
}

function fromNpmLock(lock, present, dependents) {
  if (lock?.packages) fromPackageLock(lock, present, dependents);
  else fromPackageLockV1(lock?.dependencies, present, dependents);
}

/** Lockfile per package manager, and how to read presence from it. */
const LOCK_READERS = Object.freeze({
  npm: (root, present, dependents) =>
    fromNpmLock(readJsonc(root, 'package-lock.json'), present, dependents),
  pnpm: (root, present) =>
    fromPnpmLock(readYaml(root, 'pnpm-lock.yaml'), present),
  yarn: (root, present) =>
    fromYarnLock(readText(root, 'yarn.lock') ?? '', present),
});

/**
 * `null` — "presence unknown" — when there is no lockfile, or when the one
 * there yields no package at all (unparseable, an unrecognised format, empty).
 * An empty map would read as "nothing is in the tree" and prove every pin
 * dead, the one verdict the engine may never guess.
 *
 * @param {string} root
 * @param {string|null} pm
 * @param {Map} dependents
 * @returns {Map<string, Set<string>>|null}
 */
function readPresence(root, pm, dependents) {
  const read = LOCK_READERS[pm];
  if (!read) return null;
  if (pm === 'npm' && !fs.existsSync(path.join(root, 'package-lock.json')))
    return null;
  const present = new Map();
  read(root, present, dependents);
  return present.size > 0 ? present : null;
}

function childPackageDirs(nodeModules) {
  let entries;
  try {
    entries = fs.readdirSync(nodeModules, { withFileTypes: true });
  } catch {
    return [];
  }
  const dirs = [];
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const abs = path.join(nodeModules, e.name);
    if (e.name.startsWith('@')) dirs.push(...childPackageDirs(abs));
    else dirs.push(abs);
  }
  return dirs;
}

function pnpmStoreDirs(root) {
  const store = path.join(root, 'node_modules', '.pnpm');
  let entries;
  try {
    entries = fs.readdirSync(store);
  } catch {
    return [];
  }
  return entries
    .filter(
      (e) =>
        e !== 'node_modules' && !e.startsWith('.') && !e.startsWith('lock'),
    )
    .flatMap((e) => childPackageDirs(path.join(store, e, 'node_modules')));
}

function walkInstalled(dir, depth, seen, visit) {
  if (depth > MAX_NESTING || seen.size >= MAX_INSTALLED_MANIFESTS) return;
  let real;
  try {
    real = fs.realpathSync(dir);
  } catch {
    return;
  }
  if (seen.has(real)) return;
  seen.add(real);
  const pkg = readJsonc(real, 'package.json');
  if (pkg) visit(pkg);
  for (const child of childPackageDirs(path.join(real, 'node_modules'))) {
    walkInstalled(child, depth + 1, seen, visit);
  }
}

/**
 * @param {string} root
 * @param {string[]} manifestDirs
 * @param {Map} dependents
 * @returns {boolean} whether any `node_modules` was readable.
 */
function readInstalled(root, manifestDirs, dependents) {
  const starts = [
    ...manifestDirs.flatMap((d) =>
      childPackageDirs(path.join(root, d, 'node_modules')),
    ),
    ...pnpmStoreDirs(root),
  ];
  const seen = new Set();
  for (const dir of starts) {
    walkInstalled(dir, 0, seen, (pkg) =>
      addDependents(dependents, `${pkg.name}@${pkg.version}`, pkg),
    );
  }
  return starts.length > 0;
}

/**
 * @param {object} scope - from `buildScope`.
 * @param {string} root
 * @returns {{ pm: string|null, present: Map<string, Set<string>>|null,
 *   dependents: Map<string, Array<{from: string, range: string}>>|null,
 *   declared: Set<string>, degradations: object[] }}
 */
export function buildDependencyIndex(scope, root) {
  const degradations = [];
  const pm = detectPackageManager(root);
  const dependents = new Map();
  for (const m of scope.manifests) addDependents(dependents, m.rel, m.pkg);
  const declared = new Set(dependents.keys());
  const present = readPresence(root, pm, dependents);
  if (present === null) {
    degradations.push({
      input: 'lockfile',
      reason:
        'no readable lockfile; presence probes fell back to declared manifests',
      detail: '',
    });
  }
  const fromLock = pm === 'npm' && present !== null;
  const installed =
    fromLock ||
    readInstalled(
      root,
      scope.manifests.map((m) => m.dir),
      dependents,
    );
  if (!installed) {
    degradations.push({
      input: 'dependency-manifests-unavailable',
      reason: 'no installed manifests; redundancy probes were skipped',
      detail: '',
    });
  }
  return {
    pm,
    present,
    dependents: installed ? dependents : null,
    declared,
    degradations,
  };
}
