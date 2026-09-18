#!/usr/bin/env node
/**
 * Generates the `.agentrc` config surface from the annotated runtime AJV
 * schema (the single source): the JSON-Schema mirror (fully inlined, so it
 * cannot disagree with runtime), the defaults inventory, and the key-table
 * region of `configuration.md`. JSON artifacts compare canonically — Biome
 * reformats them after write, so whitespace is ignored but key order counts.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { runAsCli } from './lib/cli-utils.js';
import { AGENTRC_SCHEMA } from './lib/config-settings-schema.js';
import { Logger } from './lib/Logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const SCHEMA_PATH = path.join(
  PROJECT_ROOT,
  '.agents',
  'schemas',
  'agentrc.schema.json',
);
const REFERENCE_PATH = path.join(
  PROJECT_ROOT,
  '.agents',
  'docs',
  'agentrc-reference.json',
);
const DOC_PATH = path.join(PROJECT_ROOT, '.agents', 'docs', 'configuration.md');
const REGION_BEGIN = '<!-- BEGIN GENERATED:agentrc -->';
const REGION_END = '<!-- END GENERATED:agentrc -->';

const MIRROR_ENVELOPE = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://github.com/dsj1984/mandrel/blob/main/.agents/schemas/agentrc.schema.json',
  title: 'Mandrel .agentrc',
  description:
    'GENERATED — do not edit. Emitted by `node .agents/scripts/generate-config-docs.js` from the runtime AJV schema in `.agents/scripts/lib/config-settings-schema.js` (plus its `-delivery` / `-quality` / `config/gates/*` modules), which is the single source of truth for the `.agentrc.json` surface. This file exists for editor tooling and human readers; because it is a serialization of the runtime schema rather than a hand-kept mirror, the two cannot disagree. Edit the annotated schema literals and re-run `npm run docs:gen`.',
};

const REFERENCE_SCHEMA_POINTER = '../schemas/agentrc.schema.json';

// Order drives section emission.
const TOP_LEVEL_KEYS = ['project', 'github', 'planning', 'delivery', 'qa'];

/**
 * @param {unknown} value
 * @returns {string}
 */
function canonicalJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/**
 * `null` when absent or unparseable — a mangled artifact is stale, not a crash.
 * @param {string} file
 * @returns {string | null}
 */
function readCanonicalJson(file) {
  if (!fs.existsSync(file)) return null;
  try {
    return canonicalJson(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch {
    return null;
  }
}

/**
 * Shared sub-schemas are inlined at each use rather than hoisted to `$defs`.
 * @param {object} schema
 * @returns {object}
 */
function buildMirrorSchema(schema) {
  return { ...MIRROR_ENVELOPE, ...structuredClone(schema) };
}

/**
 * A node carrying `default` contributes it verbatim and is not descended
 * into, so an object- or array-shaped default is declared in one place.
 * @param {object} node
 * @returns {unknown} `undefined` when nothing is contributed.
 */
function collectDefaults(node) {
  if (!node || typeof node !== 'object') return undefined;
  if (Object.hasOwn(node, 'default')) return structuredClone(node.default);
  if (!node.properties) return undefined;
  const out = {};
  for (const [key, child] of Object.entries(node.properties)) {
    const built = collectDefaults(child);
    if (built !== undefined) out[key] = built;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * @param {object} schema
 * @returns {object}
 */
function buildReferenceInventory(schema) {
  return {
    $schema: REFERENCE_SCHEMA_POINTER,
    ...(collectDefaults(schema) ?? {}),
  };
}

/**
 * `allOf` only hangs `if`/`then` constraints off a block, so the base type is
 * what the docs need.
 * @param {object} node
 * @returns {object}
 */
function flattenAllOf(node) {
  if (!node || typeof node !== 'object') return node;
  if (!Array.isArray(node.allOf)) return node;
  const merged = { ...node };
  delete merged.allOf;
  for (const member of node.allOf) {
    for (const [key, value] of Object.entries(member)) {
      if (merged[key] === undefined) merged[key] = value;
    }
  }
  return merged;
}

/**
 * @param {object} flat
 * @returns {string}
 */
function renderArrayType(flat) {
  const items = flat.items;
  if (items && typeof items === 'object') {
    if (Array.isArray(items.enum)) {
      return `\`array<enum>\``;
    }
    if (typeof items.type === 'string') {
      return `\`array<${items.type}>\``;
    }
  }
  return '`array`';
}

/**
 * @param {object} flat
 * @returns {string}
 */
function renderObjectType(flat) {
  if (
    flat.additionalProperties &&
    typeof flat.additionalProperties === 'object'
  ) {
    return '`object<map>`';
  }
  return '`object`';
}

/**
 * First match wins; `oneOf` and `enum` must precede the plain `type` rules.
 * @type {Array<{ when: (flat: object) => boolean, render: (flat: object) => string }>}
 */
const TYPE_RULES = [
  {
    // List-or-extender union: replace, or deep-merge with the framework list.
    when: (flat) =>
      Array.isArray(flat.oneOf) &&
      flat.oneOf.some((m) => m?.properties?.append || m?.properties?.prepend),
    render: () => '`string[]` or `{ append?, prepend? }`',
  },
  {
    when: (flat) => Array.isArray(flat.oneOf),
    render: (flat) =>
      `one of: ${flat.oneOf.map((m) => `\`${m?.type ?? '?'}\``).join(', ')}`,
  },
  {
    when: (flat) => Array.isArray(flat.enum),
    render: (flat) =>
      flat.enum.map((v) => `\`${JSON.stringify(v)}\``).join(' \\| '),
  },
  {
    when: (flat) => Array.isArray(flat.type),
    render: (flat) => flat.type.map((t) => `\`${t}\``).join(' \\| '),
  },
  {
    when: (flat) => flat.type === 'array',
    render: renderArrayType,
  },
  {
    when: (flat) => flat.type === 'object',
    render: renderObjectType,
  },
  {
    when: (flat) => typeof flat.type === 'string',
    render: (flat) => `\`${flat.type}\``,
  },
];

/**
 * An unmatched shape renders `?` so the gap is visible.
 * @param {object} node
 * @returns {string}
 */
function renderType(node) {
  if (!node || typeof node !== 'object') return '?';
  const flat = flattenAllOf(node);
  const rule = TYPE_RULES.find((r) => r.when(flat));
  return rule ? rule.render(flat) : '?';
}

/**
 * @param {object} node
 * @returns {string}
 */
function renderDefault(node) {
  if (!node || !Object.hasOwn(node, 'default')) return '—';
  const value = node.default;
  if (value === null) return '`null`';
  if (typeof value === 'string') return `\`"${value}"\``;
  if (typeof value === 'boolean' || typeof value === 'number') {
    return `\`${value}\``;
  }
  try {
    return `\`${JSON.stringify(value)}\``;
  } catch {
    return '—';
  }
}

/**
 * @param {string} text
 * @returns {string}
 */
function escapeCell(text) {
  return String(text).replace(/\r?\n/g, ' ').replace(/\|/g, '\\|');
}

/**
 * `null` when not a properties-bearing object, so the next builder runs.
 * @param {{flat: object, keyPath: string, pathParts: string[], propName: string, isRequired: boolean, description: string}} ctx
 * @returns {Array<object> | null}
 */
function nestedObjectRows(ctx) {
  const { flat, keyPath, pathParts, propName, isRequired, description } = ctx;
  if (flat.type !== 'object' || !flat.properties) return null;
  const childRequired = new Set(
    Array.isArray(flat.required) ? flat.required : [],
  );
  return [
    {
      key: keyPath,
      required: isRequired ? 'Yes' : 'No',
      type: '`object`',
      def: renderDefault(flat),
      description: description || 'Nested configuration block.',
    },
    ...flattenObject(flat, [...pathParts, propName], childRequired),
  ];
}

/**
 * One `[]`-suffixed row per array of objects, item keys in the Description.
 * @param {{flat: object, keyPath: string, isRequired: boolean, description: string}} ctx
 * @returns {Array<object> | null}
 */
function arrayOfObjectsRows(ctx) {
  const { flat, keyPath, isRequired, description } = ctx;
  if (flat.type !== 'array' || !flat.items) return null;
  const itemNode = flat.items;
  if (!itemNode || itemNode.type !== 'object' || !itemNode.properties) {
    return null;
  }
  const itemKeys = Object.keys(itemNode.properties).join(', ');
  const desc = `${description ? `${description} ` : ''}Each item has: ${itemKeys}.`;
  return [
    {
      key: `${keyPath}[]`,
      required: isRequired ? 'Yes' : 'No',
      type: renderType(flat),
      def: renderDefault(flat),
      description: desc,
    },
  ];
}

/**
 * @param {{flat: object, keyPath: string, isRequired: boolean, description: string}} ctx
 * @returns {Array<object>}
 */
function leafRow(ctx) {
  const { flat, keyPath, isRequired, description } = ctx;
  return [
    {
      key: keyPath,
      required: isRequired ? 'Yes' : 'No',
      type: renderType(flat),
      def: renderDefault(flat),
      description: description || '—',
    },
  ];
}

// First builder returning non-null wins; leafRow always matches.
const ROW_BUILDERS = [nestedObjectRows, arrayOfObjectsRows, leafRow];

/**
 * @param {object} node
 * @param {string[]} pathParts
 * @param {Set<string>} required
 * @returns {Array<{key:string, required:string, type:string, def:string, description:string}>}
 */
function flattenObject(node, pathParts, required) {
  const rows = [];
  const properties = node.properties || {};
  const localRequired = new Set(
    Array.isArray(node.required) ? node.required : [],
  );

  for (const [propName, child] of Object.entries(properties)) {
    const flat = flattenAllOf(child);
    const ctx = {
      flat,
      keyPath: [...pathParts, propName].join('.'),
      pathParts,
      propName,
      isRequired: required.has(propName) || localRequired.has(propName),
      description: flat.description || '',
    };
    for (const build of ROW_BUILDERS) {
      const built = build(ctx);
      if (built !== null) {
        rows.push(...built);
        break;
      }
    }
  }

  return rows;
}

/**
 * @param {object} schema
 * @param {string} topKey
 * @returns {string}
 */
function renderSection(schema, topKey) {
  const node = (schema.properties || {})[topKey];
  if (!node) {
    throw new Error(`Top-level key "${topKey}" missing from schema.properties`);
  }
  const flat = flattenAllOf(node);

  if (flat.type !== 'object' || !flat.properties) {
    throw new Error(
      `Top-level key "${topKey}" is not an object schema; cannot render rows.`,
    );
  }

  const rootRequired = new Set(
    Array.isArray(schema.required) ? schema.required : [],
  );
  const sectionRequired = rootRequired.has(topKey);
  const childRequired = new Set(
    Array.isArray(flat.required) ? flat.required : [],
  );

  const rows = flattenObject(flat, [], childRequired);
  const header = `### \`${topKey}\` ${sectionRequired ? '(required)' : '(optional)'}`;
  const tableHeader = '| Key | Required | Type | Default | Description |';
  const tableSep = '| --- | --- | --- | --- | --- |';
  const tableBody = rows.map(
    (r) =>
      `| \`${r.key}\` | ${r.required} | ${r.type} | ${r.def} | ${escapeCell(r.description)} |`,
  );

  const lines = [header, ''];
  if (flat.description) {
    lines.push(escapeCell(flat.description), '');
  }
  lines.push(tableHeader, tableSep, ...tableBody);
  return lines.join('\n');
}

/**
 * @param {object} schema
 * @returns {string}
 */
function renderRegion(schema) {
  const blocks = [
    '',
    '> Generated by `node .agents/scripts/generate-config-docs.js` from the',
    '> runtime AJV schema in',
    '> [`.agents/scripts/lib/config-settings-schema.js`](../scripts/lib/config-settings-schema.js).',
    '> Edit the `description` / `default` annotations on those schema literals',
    '> and re-run `npm run docs:gen` — do not hand-edit this region, and do not',
    '> hand-edit `agentrc.schema.json` or `agentrc-reference.json` either: both',
    '> are emitted by the same generator.',
    '',
  ];
  for (const key of TOP_LEVEL_KEYS) {
    blocks.push(renderSection(schema, key));
    blocks.push('');
  }
  return blocks.join('\n');
}

/**
 * Absent markers are inserted after the "## Top-level shape" block's `---`,
 * else above the first `## ` heading, else appended.
 * @param {string} original
 * @param {string} body
 * @returns {string}
 */
function spliceRegion(original, body) {
  const beginIdx = original.indexOf(REGION_BEGIN);
  const endIdx = original.indexOf(REGION_END);

  if (beginIdx !== -1 && endIdx !== -1) {
    if (endIdx < beginIdx) {
      throw new Error(
        `Region markers out of order in ${DOC_PATH}: END appears before BEGIN.`,
      );
    }
    const before = original.slice(0, beginIdx + REGION_BEGIN.length);
    const after = original.slice(endIdx);
    return `${before}\n${body}\n${after}`;
  }

  if (beginIdx !== -1 || endIdx !== -1) {
    throw new Error(
      `Only one region marker present in ${DOC_PATH}. Both must exist or neither.`,
    );
  }

  const anchor = '## Top-level shape';
  const anchorIdx = original.indexOf(anchor);
  if (anchorIdx !== -1) {
    const ruleIdx = original.indexOf('\n---\n', anchorIdx);
    if (ruleIdx !== -1) {
      const insertAt = ruleIdx + '\n---\n'.length;
      const before = original.slice(0, insertAt);
      const after = original.slice(insertAt);
      const block = `\n${REGION_BEGIN}\n${body}\n${REGION_END}\n`;
      return `${before}${block}${after}`;
    }
  }

  const headingMatch = original.match(/^## /m);
  if (headingMatch && headingMatch.index !== undefined) {
    const before = original.slice(0, headingMatch.index);
    const after = original.slice(headingMatch.index);
    const block = `${REGION_BEGIN}\n${body}\n${REGION_END}\n\n`;
    return `${before}${block}${after}`;
  }

  return `${original}\n${REGION_BEGIN}\n${body}\n${REGION_END}\n`;
}

/**
 * The Markdown artifact compares raw: its hand-authored prose must survive
 * byte-for-byte.
 * @param {{ schema?: object, schemaPath?: string, referencePath?: string,
 *   docPath?: string }} [opts]
 * @returns {Array<{ name: string, file: string, generated: string,
 *   current: string | null, stale: boolean }>}
 */
function buildArtifacts(opts = {}) {
  const {
    schema = AGENTRC_SCHEMA,
    schemaPath = SCHEMA_PATH,
    referencePath = REFERENCE_PATH,
    docPath = DOC_PATH,
  } = opts;

  if (!fs.existsSync(docPath)) {
    throw new Error(`Target doc not found: ${docPath}`);
  }
  const docOriginal = fs.readFileSync(docPath, 'utf8');

  const artifacts = [
    {
      name: 'mirror schema',
      file: schemaPath,
      generated: canonicalJson(buildMirrorSchema(schema)),
      current: readCanonicalJson(schemaPath),
    },
    {
      name: 'defaults inventory',
      file: referencePath,
      generated: canonicalJson(buildReferenceInventory(schema)),
      current: readCanonicalJson(referencePath),
    },
    {
      name: 'configuration.md key table',
      file: docPath,
      generated: spliceRegion(docOriginal, renderRegion(schema)),
      current: docOriginal,
    },
  ];
  for (const a of artifacts) a.stale = a.generated !== a.current;
  return artifacts;
}

/**
 * @param {string[]} argv
 */
async function main(argv = process.argv.slice(2)) {
  const { values } = parseArgs({
    args: argv,
    options: {
      check: { type: 'boolean', default: false },
    },
    allowPositionals: false,
  });

  const artifacts = buildArtifacts();
  const stale = artifacts.filter((a) => a.stale);
  const rel = (f) => path.relative(PROJECT_ROOT, f);

  if (values.check) {
    if (stale.length === 0) {
      Logger.info(
        `generate-config-docs: all ${artifacts.length} generated config artifacts are up to date.`,
      );
      return;
    }
    throw new Error(
      `${stale.length} generated config artifact(s) drifted from the runtime schema: ` +
        `${stale.map((a) => `${a.name} (${rel(a.file)})`).join(', ')}. ` +
        'Run `node .agents/scripts/generate-config-docs.js` to regenerate.',
    );
  }

  if (stale.length === 0) {
    Logger.info(
      'generate-config-docs: every generated config artifact already current — no write.',
    );
    return;
  }
  for (const a of stale) {
    fs.writeFileSync(a.file, a.generated, 'utf8');
  }
  Logger.info(
    `generate-config-docs: rewrote ${stale.map((a) => rel(a.file)).join(', ')}.`,
  );
}

export {
  buildArtifacts,
  buildMirrorSchema,
  buildReferenceInventory,
  canonicalJson,
  collectDefaults,
  flattenObject,
  REGION_BEGIN,
  REGION_END,
  renderRegion,
  renderSection,
  spliceRegion,
};

runAsCli(import.meta.url, main, {
  source: 'generate-config-docs',
  usage: {
    invocation: 'node .agents/scripts/generate-config-docs.js [--check]',
    summary:
      'Regenerate the three .agentrc config artifacts (JSON-Schema mirror, defaults inventory, configuration.md key table) from the runtime AJV schema. Writes only what drifted.',
    flags: [
      [
        '--check',
        'Verify every artifact is current and fail naming the stale ones; write nothing.',
      ],
    ],
  },
});
