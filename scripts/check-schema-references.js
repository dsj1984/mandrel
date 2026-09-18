#!/usr/bin/env node

/**
 * CLI: report every JSON Schema under `.agents/schemas/` that no code path
 * compiles.
 *
 * A well-formed schema sitting in a schema directory reads as an enforced
 * contract to every human reader and every audit lens — existence plus valid
 * syntax is taken for authority. When nothing actually compiles it, that
 * reading is wrong in the most expensive direction: the reader believes a
 * shape the runtime rejects. `friction-event.schema.json` sat unreferenced
 * from the Epic #4406 envelope cutover until Story #4938; in between, an
 * `/audit-documentation` lens graded a High finding against it as the live
 * contract, the finding became an acceptance criterion, and the delivering
 * worker had to overrule that criterion to avoid writing a payload the
 * enforced validator drops. Two verification layers accepted the file
 * because it existed and parsed. Only reading the code caught it.
 *
 * This gate is that code read, run every time instead of once by accident.
 *
 * ## What counts as a compiling reference
 *
 * Resolution is evidence-ranked; the first kind that hits wins, and the
 * report names both the kind and the file that supplied the evidence, so a
 * pass is auditable rather than merely green.
 *
 *   1. `literal`     — the schema's basename appears in a JS source. This is
 *                      the ordinary idiom (`signal-validator.js` resolves
 *                      `signal-event.schema.json` by literal path).
 *   2. `schema-ref`  — another schema `$ref`s this file by name, and that
 *                      schema is itself referenced. A `$ref` is a compile
 *                      edge: AJV pulls the target in when the parent
 *                      compiles.
 *   3. `dynamic`     — the schema lives in a SUBDIRECTORY of the schema root
 *                      that some JS source loads by computed path (a
 *                      `` `${key}.schema.json` `` template), AND the
 *                      schema's stem appears literally in a JS source as the
 *                      key that would produce it. `lifecycle/` is loaded this
 *                      way by `lifecycle/emit-ledger-event.js`, and
 *                      `baselines/` by `lib/baselines/envelope.js`.
 *
 *                      BOTH halves are required. The directory evidence alone
 *                      would bless every future file dropped into a
 *                      dynamically-enumerated directory — the same blindness
 *                      this gate exists to remove. Dynamic resolution is not
 *                      offered for schemas sitting at the schema root: every
 *                      root schema today is compiled by an explicit literal
 *                      path, so a root-level stem match would be coincidence,
 *                      not evidence.
 *
 * Anything left over is a finding — unless the schema says otherwise in its
 * own body (see below). A finding is not an accusation of deadness; it is a
 * demand that the file state which one it is.
 *
 * ## Recording a deliberate exemption
 *
 * A schema deliberately kept without a compiler declares it IN THE FILE, at
 * the document root:
 *
 * ```json
 * "x-mandrel-uncompiled": {
 *   "reason": "Documented SSOT; AJV is deliberately not in this path.",
 *   "runtimeGate": "lib/orchestration/foo.js#validateFooPayload"
 * }
 * ```
 *
 * In-file, never a side-car allowlist. The failure this gate answers was a
 * reader trusting the schema document; the correction has to be legible to
 * that same reader, in that same document. An allowlist elsewhere in the repo
 * would leave the file itself still lying.
 *
 * Story #4938 left the tree with two: `friction-event.schema.json` was deleted
 * outright (its shape preserved field-for-field in
 * `docs/archive/data-dictionary-2026-08.md`), and
 * `model-attribution.schema.json` — a documented SSOT with a hand-rolled
 * validator behind it — declared the marker. Story #5367 deleted that one too,
 * with the module whose validator was the gate, so the marker is now a
 * facility with no current user rather than a practice with a live example.
 *
 * The gate answers "is anything compiling this?", not "is what compiles it
 * faithful to it?". A schema whose hand-rolled mirror has silently drifted
 * still passes here.
 *
 * Flags:
 *   --root <path>  scan a different repository root (default: cwd)
 *   --json         emit the structured envelope as single-line JSON
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { runAsCli } from '../.agents/scripts/lib/cli-utils.js';
import { stripJsComments } from '../.agents/scripts/lib/source-text/strip-js-comments.js';

/** Schema root, relative to the repository root. */
const SCHEMA_ROOT = path.join('.agents', 'schemas');

/** Directories never worth walking for JS sources. */
const SKIP_DIRS = new Set([
  '.git',
  '.worktrees',
  'node_modules',
  'coverage',
  'temp',
]);

/** Source extensions that can compile a schema. */
const JS_EXTENSIONS = new Set(['.js', '.mjs', '.cjs']);

/** Root keyword a schema uses to declare a deliberate exemption. */
const EXEMPTION_KEY = 'x-mandrel-uncompiled';

/**
 * A computed schema path — `` `${something}.schema.json` `` — anywhere in a
 * source file. Evidence that the file loads schemas by runtime key rather
 * than by literal name.
 */
const COMPUTED_PATH_RE = /\$\{[^}]*\}\.schema\.json/;

/**
 * Parse argv. Exported so a unit test can pin the parser without spawning.
 *
 * @param {string[]} argv
 * @returns {{ root: string, json: boolean }}
 */
export function parseArgv(argv = []) {
  const out = { root: process.cwd(), json: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--json') out.json = true;
    else if (argv[i] === '--root' && argv[i + 1]) {
      out.root = path.resolve(argv[i + 1]);
      i += 1;
    }
  }
  return out;
}

/**
 * Recursively collect files under `dir` whose extension is in `extensions`.
 *
 * @param {string} dir absolute directory to walk
 * @param {Set<string>} extensions lowercase extensions including the dot
 * @param {string[]} [acc]
 * @returns {string[]} absolute file paths
 */
function walk(dir, extensions, acc = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(full, extensions, acc);
    } else if (extensions.has(path.extname(entry.name).toLowerCase())) {
      acc.push(full);
    }
  }
  return acc;
}

/**
 * Read every JS source in the repository once.
 *
 * @param {string} root absolute repository root
 * @returns {Array<{ rel: string, text: string }>}
 */
function readSources(root) {
  return walk(root, JS_EXTENSIONS).map((file) => ({
    rel: path.relative(root, file),
    text: stripJsComments(fs.readFileSync(file, 'utf8')),
  }));
}

/**
 * Describe every `*.schema.json` under the schema root.
 *
 * @param {string} root absolute repository root
 * @returns {Array<{ rel: string, basename: string, stem: string, dir: string, doc: object|null }>}
 */
function readSchemas(root) {
  const schemaRoot = path.join(root, SCHEMA_ROOT);
  return walk(schemaRoot, new Set(['.json']))
    .filter((file) => file.endsWith('.schema.json'))
    .map((file) => {
      const basename = path.basename(file);
      let doc = null;
      try {
        doc = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch {
        doc = null;
      }
      return {
        rel: path.relative(root, file),
        basename,
        stem: basename.slice(0, -'.schema.json'.length),
        dir: path.relative(schemaRoot, path.dirname(file)),
        doc,
      };
    })
    .sort((a, b) => a.rel.localeCompare(b.rel));
}

/**
 * Find the first source whose text contains `needle`.
 *
 * @param {Array<{ rel: string, text: string }>} sources
 * @param {string} needle
 * @returns {string | null} the relative path of the witness, or null
 */
function witness(sources, needle) {
  const hit = sources.find((source) => source.text.includes(needle));
  return hit ? hit.rel : null;
}

/**
 * Find a source that loads schemas from `dir` by computed path.
 *
 * The file must both build a runtime-keyed schema path and name the
 * directory — as a quoted `path.join` segment or as a `schemas/<dir>` path
 * fragment.
 *
 * @param {Array<{ rel: string, text: string }>} sources
 * @param {string} dir directory name relative to the schema root
 * @returns {string | null}
 */
function dynamicLoaderFor(sources, dir) {
  if (!dir) return null;
  const hit = sources.find(
    (source) =>
      COMPUTED_PATH_RE.test(source.text) &&
      (source.text.includes(`'${dir}'`) ||
        source.text.includes(`"${dir}"`) ||
        source.text.includes(`schemas/${dir}`)),
  );
  return hit ? hit.rel : null;
}

/**
 * Read a schema's in-file exemption declaration.
 *
 * A bare string is accepted as the reason; the object form additionally
 * carries `runtimeGate`, the `file.js#functionName` actually enforcing the
 * shape at runtime. That field is what makes an exemption reviewable: a
 * schema kept as a documented SSOT with a hand-rolled validator behind it is
 * a different animal from one kept purely for provenance, and the report
 * should not flatten the two.
 *
 * @param {object|null} doc parsed schema document
 * @returns {{ reason: string, runtimeGate: string | null } | null}
 */
function exemption(doc) {
  const block = doc?.[EXEMPTION_KEY];
  const reason = typeof block === 'string' ? block : block?.reason;
  if (typeof reason !== 'string' || !reason.trim()) return null;
  const gate =
    typeof block?.runtimeGate === 'string' ? block.runtimeGate : null;
  return { reason: reason.trim(), runtimeGate: gate };
}

/**
 * Resolve one schema to a reference kind plus the evidence for it.
 *
 * @param {object} schema a `readSchemas` record
 * @param {Array<{ rel: string, text: string }>} sources
 * @param {Array<{ rel: string, text: string }>} schemaTexts raw schema bodies
 * @returns {{ kind: string, evidence: string | object | null }}
 */
function resolveSchema(schema, sources, schemaTexts) {
  const literal = witness(sources, schema.basename);
  if (literal) return { kind: 'literal', evidence: literal };

  const ref = schemaTexts.find(
    (other) =>
      other.rel !== schema.rel &&
      other.text.includes(`"$ref"`) &&
      other.text.includes(schema.basename),
  );
  if (ref) return { kind: 'schema-ref', evidence: ref.rel };

  const loader = dynamicLoaderFor(sources, schema.dir);
  if (loader) {
    const key = witness(sources, schema.stem);
    if (key) return { kind: 'dynamic', evidence: `${loader} (key: ${key})` };
  }

  const declared = exemption(schema.doc);
  if (declared) return { kind: 'exempt', evidence: declared };

  return { kind: 'unreferenced', evidence: null };
}

/**
 * Run the audit and return a structured envelope.
 *
 * @param {{ root?: string }} [opts]
 * @returns {{ schemaCount: number, referenced: number, exempt: Array<object>, findings: Array<object> }}
 */
export function auditSchemaReferences(opts = {}) {
  const root = opts.root ?? process.cwd();
  const sources = readSources(root);
  const schemas = readSchemas(root);
  const schemaTexts = schemas.map((schema) => ({
    rel: schema.rel,
    text: fs.readFileSync(path.join(root, schema.rel), 'utf8'),
  }));

  const exempt = [];
  const findings = [];
  let referenced = 0;

  for (const schema of schemas) {
    const { kind, evidence } = resolveSchema(schema, sources, schemaTexts);
    if (kind === 'unreferenced') findings.push({ schema: schema.rel });
    else if (kind === 'exempt')
      exempt.push({ schema: schema.rel, ...evidence });
    else referenced += 1;
  }

  return { schemaCount: schemas.length, referenced, exempt, findings };
}

/**
 * Render the human-readable report.
 *
 * @param {ReturnType<typeof auditSchemaReferences>} report
 * @returns {string}
 */
function formatReport(report) {
  const digest =
    `[check-schema-references] ${report.schemaCount} schema(s): ` +
    `${report.referenced} compiled, ${report.exempt.length} exempt, ` +
    `${report.findings.length} unreferenced.`;
  if (report.findings.length === 0) return digest;
  const lines = report.findings.map(
    (finding) => `  ✗ ${finding.schema} — no code path compiles it.`,
  );
  return [
    digest,
    ...lines,
    '',
    'Every schema under .agents/schemas/ must be compiled by code, or say in',
    `its own body why not. Either delete it, wire it, or add a root-level`,
    `"${EXEMPTION_KEY}": { "reason": "…" } declaring the retention.`,
  ].join('\n');
}

/**
 * CLI entry point.
 *
 * @param {string[]} [argv]
 * @returns {Promise<number>} process exit code
 */
export async function main(argv = process.argv.slice(2)) {
  const { root, json } = parseArgv(argv);
  const report = auditSchemaReferences({ root });
  process.stdout.write(
    json ? `${JSON.stringify(report)}\n` : `${formatReport(report)}\n`,
  );
  return report.findings.length > 0 ? 1 : 0;
}

runAsCli(import.meta.url, main, {
  source: 'check-schema-references',
  propagateExitCode: true,
});
