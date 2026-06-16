#!/usr/bin/env node
/**
 * .agents/scripts/generate-config-docs.js — Schema-backed `.agentrc` reference
 *
 * Renders a bounded region inside `.agents/docs/configuration.md` from
 * `.agents/schemas/agentrc.schema.json`. The region is delimited by:
 *
 *     <!-- BEGIN GENERATED:agentrc -->
 *     ...generated tables...
 *     <!-- END GENERATED:agentrc -->
 *
 * One Markdown section is emitted per top-level schema key (`project`,
 * `github`, `planning`, `delivery`). Each section's table has columns:
 *
 *     | Key | Required | Type | Default | Description |
 *
 * Nested properties are flattened into dot-paths (e.g. `paths.agentRoot`,
 * `branchProtection.requiredChecks[]`). Defaults, descriptions, and types
 * are sourced from the schema directly; rows without a `default` declaration
 * render `—`.
 *
 * Modes:
 *   (default)  — rewrites the bounded region in place. If the region markers
 *                are absent from `.agents/docs/configuration.md`, they are inserted
 *                just after the "Top-level shape" section header before the
 *                hand-authored per-section docs.
 *   --check    — exits 0 when the on-disk region matches the freshly
 *                generated content, exits 1 with a diff hint otherwise.
 *
 * Per `.agents/rules/orchestration-error-handling.md`, unrecoverable
 * failures surface via `throw new Error(...)` so `runAsCli` can map the
 * throw to `process.exit(1)` deterministically (no `Logger.fatal`).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { runAsCli } from './lib/cli-utils.js';
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
const DOC_PATH = path.join(PROJECT_ROOT, '.agents', 'docs', 'configuration.md');
const REGION_BEGIN = '<!-- BEGIN GENERATED:agentrc -->';
const REGION_END = '<!-- END GENERATED:agentrc -->';

// Order matters — drives the per-section emission sequence.
const TOP_LEVEL_KEYS = ['project', 'github', 'planning', 'delivery'];

/**
 * Read and parse the agentrc JSON Schema.
 *
 * @param {string} file Absolute path to the schema file.
 * @returns {object}
 */
function readSchema(file) {
  if (!fs.existsSync(file)) {
    throw new Error(`Schema file not found: ${file}`);
  }
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw new Error(`Failed to read schema ${file}: ${err.message}`);
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`Failed to parse schema ${file}: ${err.message}`);
  }
}

/**
 * Resolve a `$ref` pointing into `#/$defs/<name>`. Throws on unknown refs
 * because every ref in the agentrc schema is a local one.
 *
 * @param {object} schema The root schema object.
 * @param {string} ref    The `$ref` value.
 * @returns {object}
 */
function resolveRef(schema, ref) {
  if (typeof ref !== 'string' || !ref.startsWith('#/$defs/')) {
    throw new Error(`Unsupported $ref shape: ${ref}`);
  }
  const name = ref.slice('#/$defs/'.length);
  const target = schema.$defs?.[name];
  if (!target) {
    throw new Error(`Unresolved $ref: ${ref}`);
  }
  return target;
}

/**
 * Collapse an `allOf` envelope down to its first concrete sub-schema. The
 * agentrc schema uses `allOf` exclusively to apply guard constraints
 * (`safeString`, `minLength`) on top of a base type — the first member
 * carries the type for documentation purposes.
 *
 * @param {object} schema The root schema (needed for ref resolution).
 * @param {object} node   The schema node to flatten.
 * @returns {object}
 */
function flattenAllOf(schema, node) {
  if (!node || typeof node !== 'object') return node;
  if (!Array.isArray(node.allOf)) return node;
  const merged = { ...node };
  delete merged.allOf;
  for (const member of node.allOf) {
    const resolved = member.$ref ? resolveRef(schema, member.$ref) : member;
    for (const [key, value] of Object.entries(resolved)) {
      if (merged[key] === undefined) merged[key] = value;
    }
  }
  return merged;
}

/**
 * Resolve a property node down to its first non-ref form. Returns the
 * resolved node alongside the original ref name (if any) so callers can
 * detect when to recurse into a referenced object def.
 *
 * @param {object} schema
 * @param {object} node
 * @returns {{ node: object, refName: string | null }}
 */
function resolveNode(schema, node) {
  if (node && typeof node === 'object' && typeof node.$ref === 'string') {
    const refName = node.$ref.startsWith('#/$defs/')
      ? node.$ref.slice('#/$defs/'.length)
      : null;
    return { node: resolveRef(schema, node.$ref), refName };
  }
  return { node, refName: null };
}

/**
 * Render the "Type" cell for an `array`-typed node by inspecting its `items`
 * schema. Mirrors the original inline ladder exactly: a `$ref` item renders
 * `array<RefName>`, an enum item renders `array<enum>`, a typed item renders
 * `array<type>`, and anything else collapses to a bare `array`.
 *
 * @param {object} flat Flattened array node.
 * @returns {string}
 */
function renderArrayType(flat) {
  const items = flat.items;
  if (items && typeof items === 'object') {
    if (items.$ref) {
      const refName = items.$ref.startsWith('#/$defs/')
        ? items.$ref.slice('#/$defs/'.length)
        : items.$ref;
      return `\`array<${refName}>\``;
    }
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
 * Render the "Type" cell for an `object`-typed node — `object<map>` when it
 * carries an `additionalProperties` schema (the map form), `object`
 * otherwise.
 *
 * @param {object} flat Flattened object node.
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
 * Ordered dispatch table for the "Type" cell. Each rule pairs a `when(flat)`
 * predicate with a `render(flat)` producer; {@link renderType} walks the
 * table once and returns the first match, so a new schema shape becomes a new
 * row here rather than another nested branch.
 *
 * Order is load-bearing — `oneOf` and `enum` are matched before the plain
 * `type` rules, exactly as the original ladder short-circuited.
 *
 * @type {Array<{ when: (flat: object) => boolean, render: (flat: object) => string }>}
 */
const TYPE_RULES = [
  // The only oneOf in the schema is `listOrExtenderOfStrings`.
  {
    when: (flat) => Array.isArray(flat.oneOf),
    render: () => '`string[]` or `{ append?, prepend? }`',
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
 * Render the "Type" cell for a schema node. The agentrc schema uses a few
 * recurring shapes — string, integer, number, boolean, array, object,
 * `oneOf` (the `listOrExtenderOfStrings` extender form), enum, and nullable
 * variants. Anything else falls through to a `?` so missing coverage is
 * visible rather than silently wrong.
 *
 * @param {object} schema
 * @param {object} node
 * @returns {string}
 */
function renderType(schema, node) {
  if (!node || typeof node !== 'object') return '?';
  const flat = flattenAllOf(schema, node);
  const rule = TYPE_RULES.find((r) => r.when(flat));
  return rule ? rule.render(flat) : '?';
}

/**
 * Render the "Default" cell. Schemas without an explicit `default` get an
 * em dash — the value is documented prose-side in `.agents/docs/configuration.md`.
 *
 * @param {unknown} value
 * @returns {string}
 */
function renderDefault(value) {
  if (value === undefined) return '—';
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
 * Escape pipe characters so they survive Markdown table cell parsing.
 *
 * @param {string} text
 * @returns {string}
 */
function escapeCell(text) {
  return String(text).replace(/\r?\n/g, ' ').replace(/\|/g, '\\|');
}

/**
 * Emit the rows for a nested-object property: a header row carrying the
 * parent's description followed by the recursively-flattened child rows.
 * Returns `null` when `flat` is not a properties-bearing object, so the
 * caller can fall through to the next row shape.
 *
 * @param {object} schema
 * @param {{flat: object, keyPath: string, pathParts: string[], propName: string, isRequired: boolean, description: string}} ctx
 * @returns {Array<object> | null}
 */
function nestedObjectRows(schema, ctx) {
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
      def: renderDefault(flat.default),
      description: description || 'Nested configuration block.',
    },
    ...flattenObject(schema, flat, [...pathParts, propName], childRequired),
  ];
}

/**
 * Emit the single `[]`-suffixed row for an array-of-objects property,
 * describing the item shape in the Description cell. Returns `null` when the
 * property is not an array whose items are a properties-bearing object.
 *
 * @param {object} schema
 * @param {{flat: object, keyPath: string, isRequired: boolean, description: string}} ctx
 * @returns {Array<object> | null}
 */
function arrayOfObjectsRows(schema, ctx) {
  const { flat, keyPath, isRequired, description } = ctx;
  if (flat.type !== 'array' || !flat.items) return null;
  const { node: itemNode, refName } = resolveNode(schema, flat.items);
  if (!itemNode || itemNode.type !== 'object' || !itemNode.properties) {
    return null;
  }
  const itemKeys = Object.keys(itemNode.properties).join(', ');
  const suffix = refName ? ` (\`${refName}\`)` : '';
  const desc =
    (description ? `${description} ` : '') +
    `Each item${suffix} has: ${itemKeys}.`;
  return [
    {
      key: `${keyPath}[]`,
      required: isRequired ? 'Yes' : 'No',
      type: renderType(schema, flat),
      def: renderDefault(flat.default),
      description: desc,
    },
  ];
}

/**
 * Emit the leaf (scalar / non-recursed) row for a property. Always matches —
 * it is the fallthrough shape when neither the nested-object nor the
 * array-of-objects builder applied.
 *
 * @param {object} schema
 * @param {{flat: object, keyPath: string, isRequired: boolean, description: string}} ctx
 * @returns {Array<object>}
 */
function leafRow(schema, ctx) {
  const { flat, keyPath, isRequired, description } = ctx;
  return [
    {
      key: keyPath,
      required: isRequired ? 'Yes' : 'No',
      type: renderType(schema, flat),
      def: renderDefault(flat.default),
      description: description || '—',
    },
  ];
}

// Ordered row-shape builders for one property. The loop in flattenObject
// returns the first builder that yields rows (non-null), matching the
// original if/continue ladder: nested-object first, array-of-objects next,
// scalar leaf as the always-matching fallthrough.
const ROW_BUILDERS = [nestedObjectRows, arrayOfObjectsRows, leafRow];

/**
 * Flatten one object-typed schema node into table rows. Recurses into
 * nested `object` properties (resolving `$ref`s along the way) so dot-paths
 * like `paths.agentRoot` and `branchProtection.requiredChecks` show up as
 * individual rows.
 *
 * Arrays of objects (`requiredChecks[]`, `routes[]`, `bundles[]`) are
 * emitted as a single row whose Key column carries a `[]` suffix; the row's
 * item shape is captured in the Description cell. This keeps the output
 * legible without exploding into per-item-property rows.
 *
 * @param {object} schema     Root schema (for ref resolution).
 * @param {object} node       Schema node to flatten.
 * @param {string[]} pathParts Dot-path accumulator.
 * @param {Set<string>} required Required-property names on the parent.
 * @returns {Array<{key:string, required:string, type:string, def:string, description:string}>}
 */
function flattenObject(schema, node, pathParts, required) {
  const rows = [];
  const properties = node.properties || {};
  const localRequired = new Set(
    Array.isArray(node.required) ? node.required : [],
  );

  for (const [propName, rawChild] of Object.entries(properties)) {
    const { node: child } = resolveNode(schema, rawChild);
    const flat = flattenAllOf(schema, child);
    const ctx = {
      flat,
      keyPath: [...pathParts, propName].join('.'),
      pathParts,
      propName,
      isRequired: required.has(propName) || localRequired.has(propName),
      description: flat.description || rawChild.description || '',
    };
    for (const build of ROW_BUILDERS) {
      const built = build(schema, ctx);
      if (built !== null) {
        rows.push(...built);
        break;
      }
    }
  }

  return rows;
}

/**
 * Render the Markdown body for one top-level section.
 *
 * @param {object} schema
 * @param {string} topKey
 * @returns {string}
 */
function renderSection(schema, topKey) {
  const rootProps = schema.properties || {};
  const rawNode = rootProps[topKey];
  if (!rawNode) {
    throw new Error(`Top-level key "${topKey}" missing from schema.properties`);
  }
  const { node } = resolveNode(schema, rawNode);
  const flat = flattenAllOf(schema, node);

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

  const rows = flattenObject(schema, flat, [], childRequired);
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
 * Render the full bounded-region body (excluding the markers themselves).
 *
 * @param {object} schema
 * @returns {string}
 */
function renderRegion(schema) {
  const blocks = [
    '',
    '> Generated by `node .agents/scripts/generate-config-docs.js` from',
    `> [\`.agents/schemas/agentrc.schema.json\`](../schemas/agentrc.schema.json).`,
    '> Edit the schema (and its AJV mirror under `.agents/scripts/lib/`),',
    '> then re-run the generator — do not hand-edit this region.',
    '',
  ];
  for (const key of TOP_LEVEL_KEYS) {
    blocks.push(renderSection(schema, key));
    blocks.push('');
  }
  return blocks.join('\n');
}

/**
 * Substitute the bounded region inside `original`. If the markers are
 * absent, inject them just after the "## Top-level shape" section's
 * trailing horizontal rule (the first `---` after that heading) so the
 * generated reference lands before the hand-authored per-section docs.
 * If no anchor is found, prepend the markers above the first `## ` heading.
 *
 * @param {string} original
 * @param {string} body Region body including leading/trailing blank lines.
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

  // Markers absent — insert them after the "## Top-level shape" block.
  const anchor = '## Top-level shape';
  const anchorIdx = original.indexOf(anchor);
  if (anchorIdx !== -1) {
    // Find the next `---` separator after the anchor.
    const ruleIdx = original.indexOf('\n---\n', anchorIdx);
    if (ruleIdx !== -1) {
      const insertAt = ruleIdx + '\n---\n'.length;
      const before = original.slice(0, insertAt);
      const after = original.slice(insertAt);
      const block = `\n${REGION_BEGIN}\n${body}\n${REGION_END}\n`;
      return `${before}${block}${after}`;
    }
  }

  // Fallback: insert above the first `## ` heading.
  const headingMatch = original.match(/^## /m);
  if (headingMatch && headingMatch.index !== undefined) {
    const before = original.slice(0, headingMatch.index);
    const after = original.slice(headingMatch.index);
    const block = `${REGION_BEGIN}\n${body}\n${REGION_END}\n\n`;
    return `${before}${block}${after}`;
  }

  // Last-ditch: append.
  return `${original}\n${REGION_BEGIN}\n${body}\n${REGION_END}\n`;
}

/**
 * Build the canonical post-generation file content.
 *
 * @param {string} schemaPath
 * @param {string} docPath
 * @returns {{ generated: string, original: string }}
 */
function buildExpected(schemaPath, docPath) {
  if (!fs.existsSync(docPath)) {
    throw new Error(`Target doc not found: ${docPath}`);
  }
  const original = fs.readFileSync(docPath, 'utf8');
  const schema = readSchema(schemaPath);
  const body = renderRegion(schema);
  const generated = spliceRegion(original, body);
  return { generated, original };
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

  const { generated, original } = buildExpected(SCHEMA_PATH, DOC_PATH);

  if (values.check) {
    if (generated === original) {
      Logger.info(
        `generate-config-docs: ${path.relative(PROJECT_ROOT, DOC_PATH)} is up to date.`,
      );
      return;
    }
    const hint =
      `${path.relative(PROJECT_ROOT, DOC_PATH)} is out of date. ` +
      'Run `node .agents/scripts/generate-config-docs.js` to regenerate the bounded region.';
    throw new Error(hint);
  }

  if (generated === original) {
    Logger.info(
      `generate-config-docs: ${path.relative(PROJECT_ROOT, DOC_PATH)} already current — no write.`,
    );
    return;
  }
  fs.writeFileSync(DOC_PATH, generated, 'utf8');
  Logger.info(
    `generate-config-docs: wrote bounded region into ${path.relative(PROJECT_ROOT, DOC_PATH)}.`,
  );
}

export {
  buildExpected,
  flattenObject,
  REGION_BEGIN,
  REGION_END,
  readSchema,
  renderRegion,
  renderSection,
  spliceRegion,
};

runAsCli(import.meta.url, main, { source: 'generate-config-docs' });
