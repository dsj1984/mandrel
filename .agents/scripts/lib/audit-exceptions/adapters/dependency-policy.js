/**
 * Dependency policy exemptions: pnpm peer-dependency rules and allowed
 * deprecations, Renovate ignores and disabled rules, and knip dependency
 * ignores. Each names packages; an entry naming a package that is neither
 * declared, nor in the tree, nor invoked by a script or CI workflow is `dead`.
 *
 * @module lib/audit-exceptions/adapters/dependency-policy
 */

import { lineOfName } from '../locate.js';
import { readJsonc, readText } from '../read.js';
import { makeRecord } from '../record.js';

const RENOVATE_FILES = Object.freeze([
  'renovate.json',
  'renovate.jsonc',
  '.renovaterc',
  '.renovaterc.json',
  '.github/renovate.json',
  '.github/renovate.jsonc',
]);

const KNIP_FILES = Object.freeze([
  'knip.json',
  'knip.jsonc',
  '.knip.json',
  '.knip.jsonc',
]);

const PLAIN_NAME_RE = /^(?:@[\w.-]+\/)?[\w.-]+$/;

/** Text a package can be invoked from without being declared: scripts, CI, Dockerfiles. */
function invocationText(ctx) {
  if (ctx.cache.invocationText === undefined) {
    const scripts = ctx.scope.manifests.map((m) =>
      JSON.stringify(m.pkg.scripts ?? {}),
    );
    const ci = ctx.scope.files
      .filter(
        (f) => f.startsWith('.github/workflows/') || /(^|\/)Dockerfile/.test(f),
      )
      .map((f) => readText(ctx.root, f) ?? '');
    ctx.cache.invocationText = [...scripts, ...ci].join('\n');
  }
  return ctx.cache.invocationText;
}

/**
 * @param {object} ctx
 * @param {string} name
 * @returns {{ verdict: string, basis: string }}
 */
export function nameProbe(ctx, name) {
  if (!PLAIN_NAME_RE.test(name))
    return { verdict: 'unknown', basis: 'pattern-entry' };
  const index = ctx.deps();
  if (index.declared.has(name) || index.present?.has(name)) {
    return { verdict: 'live', basis: 'package-in-tree' };
  }
  if (index.present === null)
    return { verdict: 'unknown', basis: 'no-lockfile' };
  if (invocationText(ctx).includes(name))
    return { verdict: 'live', basis: 'invoked' };
  return { verdict: 'dead', basis: 'package-not-in-tree' };
}

/**
 * @param {object} ctx
 * @param {object} opts - `anchors` are the section keys a name is searched
 *   after (see `lineOf`).
 */
function namesRecords(
  ctx,
  { adapter, surface, file, text, names, justification, anchors },
) {
  return names
    .filter((n) => typeof n === 'string' && n.length > 0)
    .map((name) =>
      makeRecord({
        adapter,
        category: 'dependency',
        surface,
        file,
        line: lineOfName(text, name, anchors),
        target: name,
        rule: surface,
        justification,
        probe: nameProbe(ctx, name),
      }),
    );
}

function peerRuleRecords(ctx, file, block, text, prefix = []) {
  if (!block) return [];
  const rules = block.peerDependencyRules ?? {};
  const groups = [
    ['peerDependencyRules.ignoreMissing', rules.ignoreMissing ?? []],
    ['peerDependencyRules.allowAny', rules.allowAny ?? []],
    [
      'peerDependencyRules.allowedVersions',
      Object.keys(rules.allowedVersions ?? {}),
    ],
    [
      'allowedDeprecatedVersions',
      Object.keys(block.allowedDeprecatedVersions ?? {}),
    ],
  ];
  return groups.flatMap(([surface, names]) =>
    namesRecords(ctx, {
      adapter: 'dependency-policy',
      surface: `pnpm-${surface}`,
      file,
      text,
      anchors: [...prefix, surface.split('.').pop()],
      names: names.map((n) =>
        String(n)
          .split('>')
          .pop()
          .replace(/(.)@.*$/, '$1'),
      ),
      justification: null,
    }),
  );
}

function renovateRuleNames(rule) {
  return [rule.matchPackageNames, rule.matchDepNames, rule.packageNames]
    .flat()
    .filter(
      (n) => typeof n === 'string' && !n.startsWith('/') && !n.includes('*'),
    );
}

function renovateRecords(ctx, file, config, prefix = []) {
  const text = readText(ctx.root, file);
  const base = { adapter: 'dependency-policy', file, text };
  const records = namesRecords(ctx, {
    ...base,
    anchors: [...prefix, 'ignoreDeps'],
    surface: 'renovate-ignoreDeps',
    names: config.ignoreDeps ?? [],
    justification: null,
  });
  for (const rule of config.packageRules ?? []) {
    const surface =
      rule.enabled === false
        ? 'renovate-disabled-rule'
        : rule.allowedVersions
          ? 'renovate-allowedVersions'
          : null;
    if (!surface) continue;
    records.push(
      ...namesRecords(ctx, {
        ...base,
        anchors: [...prefix, 'packageRules'],
        surface,
        names: renovateRuleNames(rule),
        justification: rule.description ?? null,
      }),
    );
  }
  return records;
}

function knipRecords(ctx, file, config, prefix = []) {
  const text = readText(ctx.root, file);
  return namesRecords(ctx, {
    anchors: [...prefix, 'ignoreDependencies'],
    adapter: 'dependency-policy',
    surface: 'knip-ignoreDependencies',
    file,
    text,
    names: (config.ignoreDependencies ?? []).filter(
      (n) => typeof n === 'string',
    ),
    justification: null,
  });
}

function configFiles(ctx, candidates) {
  return candidates
    .filter((f) => ctx.scope.fileSet.has(f))
    .map((f) => ({ file: f, config: readJsonc(ctx.root, f) }));
}

function readableConfigs(ctx, candidates, label) {
  const found = configFiles(ctx, candidates);
  for (const { file, config } of found) {
    if (config === null)
      ctx.degrade('config-not-statically-readable', `${label}: ${file}`);
  }
  return found.filter((f) => f.config !== null);
}

function extract(ctx) {
  const records = [];
  for (const m of ctx.scope.manifests) {
    const text = readText(ctx.root, m.rel);
    records.push(...peerRuleRecords(ctx, m.rel, m.pkg.pnpm, text, ['"pnpm"']));
    if (m.pkg.renovate)
      records.push(
        ...renovateRecords(ctx, m.rel, m.pkg.renovate, ['"renovate"']),
      );
    if (m.pkg.knip)
      records.push(...knipRecords(ctx, m.rel, m.pkg.knip, ['"knip"']));
  }
  const yamlText = readText(ctx.root, 'pnpm-workspace.yaml');
  records.push(
    ...peerRuleRecords(
      ctx,
      'pnpm-workspace.yaml',
      ctx.scope.pnpmWorkspace,
      yamlText,
    ),
  );
  if (ctx.scope.files.some((f) => f.endsWith('renovate.json5'))) {
    ctx.degrade(
      'config-not-statically-readable',
      'renovate: json5 is not parsed',
    );
  }
  for (const { file, config } of readableConfigs(
    ctx,
    RENOVATE_FILES,
    'renovate',
  )) {
    records.push(...renovateRecords(ctx, file, config));
  }
  for (const { file, config } of readableConfigs(ctx, KNIP_FILES, 'knip')) {
    records.push(...knipRecords(ctx, file, config));
  }
  return records;
}

export const dependencyPolicy = Object.freeze({
  id: 'dependency-policy',
  category: 'dependency',
  applies: (ctx) =>
    ctx.scope.manifests.length > 0
      ? { applies: true, reason: 'package manifests present' }
      : { applies: false, reason: 'no package.json' },
  extract,
});
