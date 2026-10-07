/**
 * Version pins that override what the tree would resolve on its own: npm
 * `overrides`, pnpm `overrides` (in `package.json#pnpm` or
 * `pnpm-workspace.yaml`) and yarn `resolutions`, in the root and every
 * workspace manifest. A pin is `dead` when its package left the tree, or when
 * every dependent already asks for a range inside the pin — removing it would
 * change nothing.
 *
 * @module lib/audit-exceptions/adapters/dependency-pins
 */

import { nameOfSpec } from '../dependency-index.js';
import { rangeIsSubset } from '../range-subset.js';
import { lineOf, readText } from '../read.js';
import { makeRecord } from '../record.js';

/**
 * The package.json `//` note for a key, e.g. `"//": { "overrides.js-yaml": "…" }`.
 *
 * @param {object} pkg
 * @param {string} key
 * @returns {string|null}
 */
export function noteFor(pkg, key) {
  const notes = pkg?.['//'];
  if (!notes || typeof notes !== 'object' || Array.isArray(notes)) return null;
  const note = notes[key];
  return typeof note === 'string' ? note : null;
}

/** npm `overrides` → leaves `{ key, value }`; `"."` pins the parent itself. */
function npmLeaves(node, out = []) {
  for (const [key, value] of Object.entries(node ?? {})) {
    if (typeof value === 'string') {
      out.push({ key, target: nameOfSpec(key), value });
    } else if (value && typeof value === 'object') {
      if (typeof value['.'] === 'string') {
        out.push({ key, target: nameOfSpec(key), value: value['.'] });
      }
      npmLeaves(
        Object.fromEntries(Object.entries(value).filter(([k]) => k !== '.')),
        out,
      );
    }
  }
  return out;
}

/** pnpm `bar@1>foo@2` → `foo`. */
function pnpmTarget(key) {
  return nameOfSpec(key.split('>').pop());
}

/** yarn `**\/parent/@scope/foo@1` → `@scope/foo`. */
function yarnTarget(key) {
  const parts = key.split('/');
  const last = parts.pop();
  const scope = parts.at(-1);
  return nameOfSpec(scope?.startsWith('@') ? `${scope}/${last}` : last);
}

function flatLeaves(node, toTarget) {
  return Object.entries(node ?? {})
    .filter(([, value]) => typeof value === 'string')
    .map(([key, value]) => ({ key, target: toTarget(key), value }));
}

/**
 * @param {string} name
 * @param {string|null} range - the pinned range; `null` when not comparable.
 * @param {object} index - from `buildDependencyIndex`.
 * @returns {{ verdict: string, basis: string }}
 */
function pinProbe(name, range, index) {
  const inTree = index.present?.has(name) ?? null;
  if (inTree === false && !index.declared.has(name)) {
    return { verdict: 'dead', basis: 'absent-from-tree' };
  }
  if (range === null || index.dependents === null) {
    return { verdict: 'unknown', basis: 'redundancy-unprobed' };
  }
  const asks = index.dependents.get(name) ?? [];
  if (asks.length === 0)
    return { verdict: 'unknown', basis: 'no-dependent-ranges' };
  const verdicts = asks.map((a) => rangeIsSubset(a.range, range));
  if (verdicts.includes(false))
    return { verdict: 'live', basis: 'dependent-needs-pin' };
  if (verdicts.includes(null))
    return { verdict: 'unknown', basis: 'range-undecidable' };
  return { verdict: 'dead', basis: 'redundant' };
}

/** `$name` → the manifest's own direct range for `name`. */
function resolveValue(value, pkg) {
  const ref = /^\$(.*)$/.exec(value);
  if (!ref) return value === '-' ? null : value;
  const name = ref[1];
  return pkg.dependencies?.[name] ?? pkg.devDependencies?.[name] ?? null;
}

const SOURCES = Object.freeze([
  {
    surface: 'npm-overrides',
    from: (pkg) => npmLeaves(pkg.overrides),
    noteKey: (key) => `overrides.${key}`,
  },
  {
    surface: 'pnpm-overrides',
    from: (pkg) => flatLeaves(pkg.pnpm?.overrides, pnpmTarget),
    noteKey: (key) => `pnpm.overrides.${key}`,
  },
  {
    surface: 'yarn-resolutions',
    from: (pkg) => flatLeaves(pkg.resolutions, yarnTarget),
    noteKey: (key) => `resolutions.${key}`,
  },
]);

function manifestRecords(ctx, manifest) {
  const text = readText(ctx.root, manifest.rel);
  const records = [];
  for (const source of SOURCES) {
    for (const leaf of source.from(manifest.pkg)) {
      const range = resolveValue(leaf.value, manifest.pkg);
      records.push(
        makeRecord({
          adapter: 'dependency-pins',
          category: 'dependency',
          surface: source.surface,
          file: manifest.rel,
          line: lineOf(text, `"${leaf.key}"`),
          target: leaf.target,
          rule: source.surface,
          justification: noteFor(manifest.pkg, source.noteKey(leaf.key)),
          probe: pinProbe(leaf.target, range, ctx.deps()),
        }),
      );
    }
  }
  return records;
}

function workspaceYamlRecords(ctx) {
  const overrides = ctx.scope.pnpmWorkspace?.overrides;
  if (!overrides) return [];
  const text = readText(ctx.root, 'pnpm-workspace.yaml');
  return flatLeaves(overrides, pnpmTarget).map((leaf) =>
    makeRecord({
      adapter: 'dependency-pins',
      category: 'dependency',
      surface: 'pnpm-overrides',
      file: 'pnpm-workspace.yaml',
      line: lineOf(text, leaf.key),
      target: leaf.target,
      rule: 'pnpm-overrides',
      justification: null,
      probe: pinProbe(leaf.target, resolveValue(leaf.value, {}), ctx.deps()),
    }),
  );
}

export const dependencyPins = Object.freeze({
  id: 'dependency-pins',
  category: 'dependency',
  applies: (ctx) =>
    ctx.scope.manifests.length > 0 || ctx.scope.pnpmWorkspace
      ? { applies: true, reason: 'package manifests present' }
      : { applies: false, reason: 'no package.json or pnpm-workspace.yaml' },
  extract: (ctx) => [
    ...ctx.scope.manifests.flatMap((m) => manifestRecords(ctx, m)),
    ...workspaceYamlRecords(ctx),
  ],
});
