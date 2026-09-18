#!/usr/bin/env node
/**
 * .agents/scripts/generate-config-docs.js — the `.agentrc` config surface
 * generator (Story #5007).
 *
 * **One annotated source, three generated artifacts.** The runtime AJV schema
 * (`AGENTRC_SCHEMA`, composed from `lib/config-settings-schema*.js` and
 * `lib/config/gates/*`) is the single hand-authored enumeration of the
 * `.agentrc.json` surface. `description` and `default` annotations live on
 * those literals — AJV ignores both — and this generator emits everything
 * downstream of them:
 *
 *   1. `.agents/schemas/agentrc.schema.json` — the JSON-Schema mirror every
 *      consumer `.agentrc.json` points `$schema` at. Serialized 2020-12,
 *      fully inlined (no `$defs`): it IS the runtime schema, so the class of
 *      bug where a key exists in the mirror but not in the runtime AJV — and
 *      a consumer's whole config is therefore dead on arrival (Epic #4131) —
 *      cannot be expressed any more.
 *   2. `.agents/docs/agentrc-reference.json` — the defaults inventory
 *      `lib/config/defaults.js` reads for `mandrel explain` and the
 *      sync-agentrc redundancy advisory. Built from the `default`
 *      annotations: a node carrying one contributes its value verbatim and is
 *      not descended into; a node carrying none contributes nothing.
 *   3. The bounded key-table region inside `.agents/docs/configuration.md`,
 *      delimited by:
 *
 *          <!-- BEGIN GENERATED:agentrc -->
 *          ...generated tables...
 *          <!-- END GENERATED:agentrc -->
 *
 *      One Markdown section per top-level schema key, each table columned
 *      `| Key | Required | Type | Default | Description |`, with nested
 *      properties flattened into dot-paths (`paths.agentRoot`,
 *      `branchProtection.requiredChecks[]`).
 *
 * Until this Story the first two were hand-maintained alongside the runtime
 * schema and reconciled by two parity suites; those suites are now
 * generator-fidelity checks.
 *
 * Modes:
 *   (default)  — rewrite any artifact whose content is stale.
 *   --check    — exit 0 when all three are current, exit 1 naming the stale
 *                ones. Wired into `npm run docs:check`, hence `npm run lint`.
 *
 * **Whitespace is not content.** The two JSON artifacts are re-formatted by
 * Biome via lint-staged after they are written, so comparing raw bytes would
 * make the check fail on formatting alone. Both comparison and write go
 * through {@link canonicalJson}: parse, re-serialize, compare. That is
 * insensitive to whitespace and *sensitive* to key order, which is what
 * actually matters — key order drives the doc-table order and the ordering a
 * consumer's editor offers completions in.
 *
 * Per `docs/contributing/orchestration-error-handling.md`, unrecoverable
 * failures surface via `throw new Error(...)` so `runAsCli` can map the
 * throw to `process.exit(1)` deterministically (no `Logger.fatal`).
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

/** Envelope keys prepended to the serialized runtime schema. */
const MIRROR_ENVELOPE = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://github.com/dsj1984/mandrel/blob/main/.agents/schemas/agentrc.schema.json',
  title: 'Mandrel .agentrc',
  description:
    'GENERATED — do not edit. Emitted by `node .agents/scripts/generate-config-docs.js` from the runtime AJV schema in `.agents/scripts/lib/config-settings-schema.js` (plus its `-delivery` / `-quality` / `config/gates/*` modules), which is the single source of truth for the `.agentrc.json` surface. This file exists for editor tooling and human readers; because it is a serialization of the runtime schema rather than a hand-kept mirror, the two cannot disagree. Edit the annotated schema literals and re-run `npm run docs:gen`.',
};

/** `$schema` pointer written into the generated defaults inventory. */
const REFERENCE_SCHEMA_POINTER = '../schemas/agentrc.schema.json';

// Order matters — drives the per-section emission sequence.
const TOP_LEVEL_KEYS = ['project', 'github', 'planning', 'delivery', 'qa'];

/**
 * Canonical JSON text for comparison and for writing. Key order is preserved
 * (and therefore compared); whitespace is normalized away.
 *
 * @param {unknown} value
 * @returns {string}
 */
function canonicalJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/**
 * Read a JSON artifact and return its canonical text, or `null` when the file
 * is absent (first generation) or unparseable (a hand-mangled artifact is
 * treated as stale, not as a crash).
 *
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
 * Build the shipped JSON-Schema mirror: the 2020-12 envelope followed by the
 * runtime schema verbatim.
 *
 * The runtime schema is a plain, cycle-free object literal (no RegExp or
 * function values), so `structuredClone` is a faithful serialization. Shared
 * sub-schema objects — `TOLERANCE_SCHEMA` and friends, referenced by several
 * gates — are inlined at each use rather than hoisted into `$defs`. The
 * inlined document is smaller than the hand-maintained `$defs` mirror it
 * replaces, and it removes the naming heuristic a hoisting pass would need.
 *
 * @param {object} schema
 * @returns {object}
 */
function buildMirrorSchema(schema) {
  return { ...MIRROR_ENVELOPE, ...structuredClone(schema) };
}

/**
 * Collect the `default` annotations under `node` into a nested plain object.
 *
 * A node carrying `default` contributes that value verbatim and is NOT
 * descended into — that is what lets an object-shaped or array-shaped default
 * (`github.branchProtection.requiredChecks`, `qa.environments`) be declared in
 * one place. A properties-bearing node with no `default` contributes an object
 * built from whichever children contributed something, or nothing at all when
 * none did.
 *
 * @param {object} node
 * @returns {unknown} The built value, or `undefined` for "contributes nothing".
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
 * Build the defaults inventory shipped as `.agents/docs/agentrc-reference.json`.
 *
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
 * Collapse an `allOf` envelope down onto its base node. The schema uses
 * `allOf` only to hang a conditional (`if`/`then`) constraint off a block, so
 * the merged view carries the base type for documentation purposes.
 *
 * @param {object} node The schema node to flatten.
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
 * Render the "Type" cell for an `array`-typed node by inspecting its `items`
 * schema: an enum item renders `array<enum>`, a typed item renders
 * `array<type>`, and anything else collapses to a bare `array`.
 *
 * @param {object} flat Flattened array node.
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
 * `type` rules.
 *
 * @type {Array<{ when: (flat: object) => boolean, render: (flat: object) => string }>}
 */
const TYPE_RULES = [
  {
    // The list-or-extender union: a plain `string[]` (replace) or an
    // `{ append?, prepend? }` object that deep-merges with the framework list.
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
 * Render the "Type" cell for a schema node. Anything the table does not match
 * falls through to a `?` so missing coverage is visible rather than silently
 * wrong.
 *
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
 * Render the "Default" cell. Nodes without an explicit `default` annotation
 * get an em dash — see the annotation contract in `config-settings-schema.js`
 * for why a key can have a runtime default and no annotation.
 *
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
 * Emit the single `[]`-suffixed row for an array-of-objects property,
 * describing the item shape in the Description cell. Returns `null` when the
 * property is not an array whose items are a properties-bearing object.
 *
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
 * Emit the leaf (scalar / non-recursed) row for a property. Always matches —
 * it is the fallthrough shape when neither the nested-object nor the
 * array-of-objects builder applied.
 *
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

// Ordered row-shape builders for one property. The loop in flattenObject
// returns the first builder that yields rows (non-null): nested-object first,
// array-of-objects next, scalar leaf as the always-matching fallthrough.
const ROW_BUILDERS = [nestedObjectRows, arrayOfObjectsRows, leafRow];

/**
 * Flatten one object-typed schema node into table rows. Recurses into nested
 * `object` properties so dot-paths like `paths.agentRoot` and
 * `branchProtection.requiredChecks` show up as individual rows.
 *
 * Arrays of objects (`requiredChecks[]`, `routes[]`, `bundles[]`) are emitted
 * as a single row whose Key column carries a `[]` suffix; the item shape is
 * captured in the Description cell. This keeps the output legible without
 * exploding into per-item-property rows.
 *
 * @param {object} node       Schema node to flatten.
 * @param {string[]} pathParts Dot-path accumulator.
 * @param {Set<string>} required Required-property names on the parent.
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
 * Render the Markdown body for one top-level section.
 *
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
 * Render the full bounded-region body (excluding the markers themselves).
 *
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
 * Build every generated artifact from `schema` and pair each with what is on
 * disk today.
 *
 * The JSON artifacts compare canonically (see the module header); the
 * Markdown artifact compares raw, because its region is spliced into
 * hand-authored prose that must survive byte-for-byte.
 *
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
