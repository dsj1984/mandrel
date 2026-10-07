/**
 * Exemptions declared in tool configuration: biome / eslint / knip / coverage /
 * markdownlint / prettier ignore globs and rule-disabling overrides, and
 * tsconfig excludes plus loosened compiler strictness. JS-format configs are
 * never evaluated; their presence is recorded as a degradation.
 *
 * @module lib/audit-exceptions/adapters/tool-config
 */

import path from 'node:path';
import { globsProbe, ignoreLineGlobs } from '../globs.js';
import { lineOf, readJsonc, readText } from '../read.js';
import { makeRecord } from '../record.js';

const JS_CONFIG_RE =
  /(?:^|\/)(?:eslint\.config|\.eslintrc|\.c8rc|\.nycrc|vitest\.config|jest\.config)\.(?:[cm]?[jt]s)$/;

const strings = (list) =>
  Array.isArray(list) ? list.filter((g) => typeof g === 'string') : [];

/** Does an override object switch anything off? */
const disablesSomething = (override) =>
  /"off"|"enabled":\s*false/.test(JSON.stringify(override));

/**
 * One JSON-config source: which files, and how to pick its glob exemptions.
 * `pick(config)` → `[{ rule, globs, needle }]`.
 */
const JSON_SOURCES = Object.freeze([
  {
    surface: 'biome',
    files: ['biome.json', 'biome.jsonc'],
    pick: (c) => [
      ...['files', 'linter', 'formatter'].flatMap((k) =>
        strings(c[k]?.ignore).map((g) => ({
          rule: `${k}.ignore`,
          globs: [g],
          needle: g,
        })),
      ),
      ...strings(c.files?.includes)
        .filter((g) => g.startsWith('!'))
        .map((g) => ({
          rule: 'files.includes-negation',
          globs: [g.slice(1)],
          needle: g,
        })),
      ...(c.overrides ?? []).filter(disablesSomething).map((o) => {
        const globs = strings(o.includes ?? o.include);
        return { rule: 'overrides', globs, needle: globs[0] ?? 'overrides' };
      }),
    ],
  },
  {
    surface: 'eslint',
    files: ['.eslintrc', '.eslintrc.json'],
    pick: (c) => [
      ...strings(c.ignorePatterns).map((g) => ({
        rule: 'ignorePatterns',
        globs: [g],
        needle: g,
      })),
      ...(c.overrides ?? []).filter(disablesSomething).map((o) => {
        const globs = strings([o.files].flat());
        return { rule: 'overrides', globs, needle: globs[0] ?? 'overrides' };
      }),
    ],
  },
  {
    surface: 'knip',
    files: ['knip.json', 'knip.jsonc', '.knip.json', '.knip.jsonc'],
    pick: (c) =>
      ['ignore', 'ignoreFiles'].flatMap((k) =>
        strings([c[k]].flat()).map((g) => ({ rule: k, globs: [g], needle: g })),
      ),
  },
  {
    surface: 'coverage',
    files: ['.c8rc', '.c8rc.json', '.nycrc', '.nycrc.json'],
    pick: (c) =>
      strings(c.exclude).map((g) => ({
        rule: 'exclude',
        globs: [g],
        needle: g,
      })),
  },
  {
    surface: 'markdownlint',
    files: ['.markdownlint-cli2.jsonc', '.markdownlint-cli2.json'],
    pick: (c) =>
      strings(c.ignores).map((g) => ({
        rule: 'ignores',
        globs: [g],
        needle: g,
      })),
  },
]);

const IGNORE_FILES = Object.freeze({
  '.eslintignore': 'eslint',
  '.prettierignore': 'prettier',
  '.markdownlintignore': 'markdownlint',
});

const TS_LOOSENED = Object.freeze({
  strict: false,
  noImplicitAny: false,
  strictNullChecks: false,
  skipLibCheck: true,
});

function configRecord(
  ctx,
  {
    surface,
    file,
    text,
    rule,
    target,
    globs,
    justification,
    probe,
    permanentHint,
  },
) {
  return makeRecord({
    adapter: 'tool-config',
    category: 'config',
    surface,
    file,
    line: lineOf(text, target),
    target,
    rule: `${surface}:${rule}`,
    justification,
    probe: probe ?? globsProbe(ctx, globs),
    permanentHint,
  });
}

function jsonSourceRecords(ctx, source, file, config) {
  const text = readText(ctx.root, file);
  return source.pick(config).map((p) =>
    configRecord(ctx, {
      surface: source.surface,
      file,
      text,
      rule: p.rule,
      target: p.needle,
      globs: p.globs,
    }),
  );
}

function ignoreFileRecords(ctx, file, surface) {
  const lines = (readText(ctx.root, file) ?? '').split('\n');
  const dir = path.posix.dirname(file) === '.' ? '' : path.posix.dirname(file);
  const records = [];
  lines.forEach((raw, i) => {
    const line = raw.trim();
    if (line === '' || line.startsWith('#') || line.startsWith('!')) return;
    const prev = lines[i - 1]?.trim() ?? '';
    records.push(
      makeRecord({
        adapter: 'tool-config',
        category: 'config',
        surface,
        file,
        line: i + 1,
        target: line,
        rule: `${surface}:ignore-file`,
        justification: prev.startsWith('#') ? prev.slice(1) : null,
        probe: globsProbe(ctx, ignoreLineGlobs(line, dir)),
      }),
    );
  });
  return records;
}

function tsconfigRecords(ctx, file) {
  const config = readJsonc(ctx.root, file);
  if (config === null) return [];
  const text = readText(ctx.root, file);
  const dir =
    path.posix.dirname(file) === '.' ? '' : `${path.posix.dirname(file)}/`;
  const base = { surface: 'typescript', file, text };
  const records = strings(config.exclude).map((g) =>
    configRecord(ctx, {
      ...base,
      rule: 'exclude',
      target: g,
      globs: [`${dir}${g}`],
    }),
  );
  for (const [option, loosened] of Object.entries(TS_LOOSENED)) {
    if (config.compilerOptions?.[option] !== loosened) continue;
    records.push(
      configRecord(ctx, {
        ...base,
        rule: `compilerOptions.${option}`,
        target: option,
        probe: { verdict: 'live', basis: 'setting-in-force' },
        permanentHint:
          option === 'skipLibCheck' ? 'conventional-setting' : null,
      }),
    );
  }
  return records;
}

function manifestKeyRecords(ctx) {
  const records = [];
  for (const m of ctx.scope.manifests) {
    const text = readText(ctx.root, m.rel);
    for (const [key, surface] of [
      ['c8', 'coverage'],
      ['nyc', 'coverage'],
      ['knip', 'knip'],
    ]) {
      const block = m.pkg[key];
      if (!block) continue;
      const source = JSON_SOURCES.find((s) => s.surface === surface);
      for (const p of source.pick(block)) {
        records.push(
          configRecord(ctx, {
            surface,
            file: m.rel,
            text,
            rule: p.rule,
            target: p.needle,
            globs: p.globs,
          }),
        );
      }
    }
  }
  return records;
}

function extract(ctx) {
  const { files, fileSet } = ctx.scope;
  const records = [];
  for (const source of JSON_SOURCES) {
    for (const file of source.files.filter((f) => fileSet.has(f))) {
      const config = readJsonc(ctx.root, file);
      if (config === null) ctx.degrade('config-not-statically-readable', file);
      else records.push(...jsonSourceRecords(ctx, source, file, config));
    }
  }
  for (const file of files) {
    const base = path.posix.basename(file);
    if (IGNORE_FILES[base])
      records.push(...ignoreFileRecords(ctx, file, IGNORE_FILES[base]));
    if (/^tsconfig.*\.json$/.test(base))
      records.push(...tsconfigRecords(ctx, file));
    if (JS_CONFIG_RE.test(file))
      ctx.degrade('config-not-statically-readable', file);
  }
  return [...records, ...manifestKeyRecords(ctx)];
}

export const toolConfig = Object.freeze({
  id: 'tool-config',
  category: 'config',
  applies: (ctx) =>
    ctx.scope.files.length > 0
      ? { applies: true, reason: 'tracked files present' }
      : { applies: false, reason: 'no tracked files' },
  extract,
});
