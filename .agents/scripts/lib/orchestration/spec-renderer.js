/**
 * lib/orchestration/spec-renderer.js — tickets.json → epic-spec.yaml
 * projection (2-tier shape, Story #4041).
 *
 * The decomposer (`epic-plan-decompose-author`) produces a flat array
 * of Story ticket objects keyed by stable `slug`s and linked by
 * `depends_on`. The spec reconciler consumes the declarative
 * structural representation defined by
 * `.agents/schemas/epic-spec.schema.json` — a flat
 * `{ epic, stories: [...] }` shape with Story-level `wave`,
 * `dependsOn`, and inline `acceptance[]` / `verify[]` arrays
 * projected from the decomposer's edges.
 *
 * Under the 2-tier hierarchy (Story #4041), Stories have no Feature
 * parent and no Task children — acceptance and verify steps live
 * inline on the Story, and Stories attach directly to the Epic. Any
 * `feature` or `task` ticket in the decomposer input is rejected at
 * index time (hard cutover; see `.agents/rules/git-conventions.md` §
 * "Contract Cutovers — No Shim Layer").
 *
 * `renderSpec(tickets, opts)` is the pure projection between those
 * two shapes. It:
 *
 *   1. Indexes the flat array by slug. Any unrecognised type
 *      (including the historical `feature` / `task`) raises
 *      immediately.
 *   2. Filters Story `depends_on` edges down to inter-Story
 *      references in the same Epic.
 *   3. Layers Stories into waves via `Graph.assignLayers` (depth in
 *      the story-only DAG = wave index). Stories with no inbound
 *      edges sit at `wave: 0`, matching the wave-runner's runtime
 *      convention (`build-wave-dag.js` produces the same layering at
 *      dispatch time from the live GH state, so the spec's waves are
 *      observationally identical to what dispatch will compute).
 *   4. Walks the Stories in decomposer-declared order, preserving
 *      the order the LLM emitted so the reconciler's diff stays
 *      human-readable.
 *   5. Strips `agent::*` labels from every entity. The decomposer
 *      doesn't normally write them, but they can leak via reverse-
 *      bootstrap from live GH state — and the schema forbids them
 *      (the reconciler explicitly enforces the structural/agent
 *      label split).
 *   6. Projects each Story's inline `acceptance[]` / `verify[]`
 *      arrays onto the rendered Story. The decomposer may emit
 *      these either at the top level of the ticket (preferred) or
 *      nested under a structured `body` object — the renderer reads
 *      both and prefers the top-level fields when present.
 *   7. Validates the produced object against the spec schema before
 *      returning. A renderer bug that emits a malformed spec is
 *      caught synchronously rather than failing later in `loadSpec`.
 *
 * Pure — no I/O. The validator is compiled once per process and
 * cached by absolute schema path (same cache the loader uses
 * internally; this module re-derives the path from its own location
 * so the renderer imposes no new resolution surface).
 *
 * Round-trip: parse a tickets fixture → render → write to YAML →
 * reload via `loadSpec` → the reloaded shape is structurally
 * identical to the renderer output (modulo YAML's omission of
 * `undefined` keys). Verified by `tests/scripts/spec-renderer.test.js`.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { assignLayers } from '../Graph.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// scripts/lib/orchestration/ → scripts/lib/ → scripts/ → .agents/
const DEFAULT_SCHEMA_PATH = path.resolve(
  __dirname,
  '..',
  '..',
  '..',
  'schemas',
  'epic-spec.schema.json',
);

const AGENT_LABEL_PREFIX = 'agent::';

let cachedValidator = null;
let cachedValidatorKey = null;

function getValidator(schemaPath) {
  if (cachedValidator && cachedValidatorKey === schemaPath) {
    return cachedValidator;
  }
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  const schema = JSON.parse(readFileSync(schemaPath, 'utf8'));
  cachedValidator = ajv.compile(schema);
  cachedValidatorKey = schemaPath;
  return cachedValidator;
}

/**
 * Test-only hook: drop the cached validator so a subsequent call
 * recompiles. The renderer reuses one Ajv instance per process for
 * cost reasons; tests that swap to a sandbox schema must reset it.
 */
export function _resetRendererValidatorCacheForTests() {
  cachedValidator = null;
  cachedValidatorKey = null;
}

/**
 * Raised when the rendered spec object fails schema validation. The
 * Ajv errors are normalised to `{ path, message }` so callers can
 * report the offending JSON Pointer without unwrapping Ajv's envelope.
 */
export class SpecRenderValidationError extends Error {
  /**
   * @param {Array<{path: string, message: string, params?: object}>} issues
   */
  constructor(issues) {
    const head = issues[0] ?? { path: '/', message: 'unknown' };
    super(
      `Rendered spec failed schema validation at ${head.path}: ${head.message}`,
    );
    this.name = 'SpecRenderValidationError';
    this.issues = issues;
  }
}

function normaliseAjvErrors(ajvErrors) {
  return ajvErrors.map((err) => {
    let p = err.instancePath || '/';
    if (
      err.keyword === 'required' &&
      typeof err.params?.missingProperty === 'string'
    ) {
      const sep = p === '/' ? '' : '/';
      p = `${p}${sep}${err.params.missingProperty}`;
    }
    return {
      path: p,
      message: err.message ?? 'validation failed',
      params: err.params,
    };
  });
}

function sanitizeLabels(labels) {
  if (!Array.isArray(labels)) return undefined;
  const out = [];
  const seen = new Set();
  for (const raw of labels) {
    if (typeof raw !== 'string' || raw.length === 0) continue;
    if (raw.startsWith(AGENT_LABEL_PREFIX)) continue;
    if (seen.has(raw)) continue;
    seen.add(raw);
    out.push(raw);
  }
  return out.length > 0 ? out : undefined;
}

/**
 * Descriptor table for the structured-body → markdown projection, in
 * canonical emit order (`## Goal`, `## Changes`, `## Acceptance`,
 * `## Verify`). Each descriptor reads one body field and returns the
 * section's markdown block when the field is present and non-empty, or `null`
 * to omit it. Adding a section is a one-line data edit rather than a new
 * branch in {@link renderBody}.
 *
 * @type {Array<{ field: string, render: (value: unknown) => string | null }>}
 */
const SPEC_BODY_SECTIONS = [
  {
    field: 'goal',
    render: (goal) =>
      typeof goal === 'string' && goal.length > 0 ? `## Goal\n${goal}` : null,
  },
  {
    field: 'changes',
    render: (changes) =>
      Array.isArray(changes) && changes.length > 0
        ? `## Changes\n${changes.map((c) => `- ${String(c)}`).join('\n')}`
        : null,
  },
  {
    field: 'acceptance',
    render: (acceptance) =>
      Array.isArray(acceptance) && acceptance.length > 0
        ? `## Acceptance\n${acceptance.map((a) => `- [ ] ${String(a)}`).join('\n')}`
        : null,
  },
  {
    field: 'verify',
    render: (verify) =>
      Array.isArray(verify) && verify.length > 0
        ? `## Verify\n${verify.map((v) => `- ${String(v)}`).join('\n')}`
        : null,
  },
];

/**
 * Convert a decomposer body value into a spec `body` string. The
 * decomposer schema admits two shapes for a Story body:
 *
 *   - A short string (preferred under the 2-tier hierarchy).
 *   - A structured object (`{ goal, changes[], acceptance[],
 *     verify[] }`) carried over from the legacy 4-tier Task body
 *     shape, when the decomposer chooses to inline the Story's
 *     Goal/Changes alongside its acceptance/verify arrays.
 *
 * The spec schema only models `body` as a string. For structured
 * bodies, render a compact markdown projection that preserves the
 * original sections so the reconciler's downstream issue-body apply
 * produces the same body the executing agent reads. For string
 * bodies, pass through unchanged. `undefined` / empty values drop
 * the field (the schema allows omission).
 *
 * The renderer does NOT round-trip structured bodies — by design,
 * the spec is the canonical surface once it's authored, and
 * structured bodies collapse into the markdown form on first
 * projection.
 *
 * @param {unknown} body
 * @returns {string | undefined}
 */
function renderBody(body) {
  if (body == null) return undefined;
  if (typeof body === 'string') {
    return body.length > 0 ? body : undefined;
  }
  if (typeof body !== 'object') return undefined;

  const sections = [];
  for (const descriptor of SPEC_BODY_SECTIONS) {
    const block = descriptor.render(body[descriptor.field]);
    if (block !== null) sections.push(block);
  }
  return sections.length > 0 ? sections.join('\n\n') : undefined;
}

function assignNonEmpty(target, key, value) {
  if (value === undefined) return;
  target[key] = value;
}

/**
 * Index the flat ticket array by slug. Returns the ordered Story slug
 * list alongside the lookup map so the renderer can walk Stories in
 * the decomposer's emit order.
 *
 * Under the 2-tier hierarchy (Story #4041), only the `story` type is
 * recognised. Any other type — including the historical `feature` /
 * `task` — falls through to the unknown-type guard and raises
 * immediately; there is no silent drop.
 *
 * @param {Array<object>} tickets
 */
function indexTickets(tickets) {
  const bySlug = new Map();
  const storySlugs = [];

  for (const t of tickets) {
    if (!t || typeof t !== 'object') continue;
    const slug = t.slug;
    if (typeof slug !== 'string' || slug.length === 0) {
      throw new Error(
        `[spec-renderer] ticket missing slug: ${JSON.stringify(t).slice(0, 120)}`,
      );
    }
    if (bySlug.has(slug)) {
      throw new Error(`[spec-renderer] duplicate slug "${slug}"`);
    }
    bySlug.set(slug, t);
    if (t.type === 'story') storySlugs.push(slug);
    else {
      throw new Error(
        `[spec-renderer] ticket "${slug}" has unknown type "${t.type}"`,
      );
    }
  }
  return { bySlug, storySlugs };
}

/**
 * Build the slug-keyed story dependency graph used for wave layering.
 * Drops every edge that does not reference another story slug in the
 * same Epic (defensive — Story slugs that were typo'd or self-edges
 * collapse here rather than polluting the wave count).
 *
 * @returns {{adjacency: Map<string, string[]>, layers: Map<string, number>}}
 */
function layerStories(storySlugs, bySlug) {
  const storySet = new Set(storySlugs);
  const adjacency = new Map();
  for (const slug of storySlugs) {
    const story = bySlug.get(slug);
    const deps = Array.isArray(story.depends_on) ? story.depends_on : [];
    const filtered = deps.filter((d) => storySet.has(d) && d !== slug);
    adjacency.set(slug, filtered);
  }
  const layers = assignLayers(adjacency);
  return { adjacency, layers };
}

/**
 * Project the decomposer ticket array into the structural spec object.
 *
 * @param {Array<object>} tickets — flat ticket array as emitted by the
 *   decomposer Skill (`type` = story, `slug`, `depends_on`, `title`,
 *   `body`, `labels`, `acceptance`, `verify`).
 * @param {object}        opts
 * @param {{id: number, title: string, body?: string, labels?: string[]}} opts.epic
 *   — Epic descriptor (the decomposer doesn't emit the Epic row; it's
 *   supplied by the caller, which has the live Epic ticket in hand).
 * @param {{baseline?: string, config?: string}} [opts.gates]
 *   — Optional gates section, passed through verbatim into the spec.
 * @param {string} [opts.schemaPath] — override for the schema path
 *   (tests).
 * @param {boolean} [opts.validate=true] — when `false`, skip final
 *   schema validation (used by tests that intentionally craft invalid
 *   inputs).
 * @returns {object} spec — `{ epic, stories, gates? }` matching
 *   `.agents/schemas/epic-spec.schema.json`.
 */
function validateRenderSpecInputs(tickets, opts) {
  if (!Array.isArray(tickets)) {
    throw new TypeError('[spec-renderer] tickets must be an array');
  }
  if (!opts || typeof opts !== 'object' || !opts.epic) {
    throw new TypeError('[spec-renderer] opts.epic is required');
  }
  const epic = opts.epic;
  if (!Number.isInteger(epic.id) || epic.id < 1) {
    throw new TypeError(
      '[spec-renderer] opts.epic.id must be a positive integer',
    );
  }
  if (typeof epic.title !== 'string' || epic.title.length === 0) {
    throw new TypeError('[spec-renderer] opts.epic.title must be a string');
  }
}

function pickStringArray(primary, fallback) {
  const src = Array.isArray(primary)
    ? primary
    : Array.isArray(fallback)
      ? fallback
      : null;
  if (!src) return null;
  const filtered = src.filter((s) => typeof s === 'string' && s.length > 0);
  return filtered.length > 0 ? filtered : null;
}

function extractStoryAcceptanceVerify(story) {
  // Stories carry inline
  // acceptance[] / verify[] arrays directly on the ticket. The
  // decomposer may emit these either at the top level of the ticket
  // (preferred) or nested under a structured `body` object (legacy
  // shape shared with the historical Task body). Read from both and
  // prefer the top-level fields when present.
  const fromBody =
    story.body && typeof story.body === 'object' && !Array.isArray(story.body)
      ? story.body
      : null;
  const out = {};
  const acceptance = pickStringArray(story.acceptance, fromBody?.acceptance);
  if (acceptance) out.acceptance = acceptance;
  const verify = pickStringArray(story.verify, fromBody?.verify);
  if (verify) out.verify = verify;
  return out;
}

function buildStoryOut({ story, layers, storySet }) {
  const deps = Array.isArray(story.depends_on) ? story.depends_on : [];
  const dependsOn = [
    ...new Set(deps.filter((d) => storySet.has(d) && d !== story.slug)),
  ];

  const out = {
    slug: story.slug,
    title: story.title,
    wave: layers.get(story.slug) ?? 0,
  };
  assignNonEmpty(out, 'body', renderBody(story.body));
  if (dependsOn.length > 0) out.dependsOn = dependsOn;
  assignNonEmpty(out, 'labels', sanitizeLabels(story.labels));
  const av = extractStoryAcceptanceVerify(story);
  if (av.acceptance) out.acceptance = av.acceptance;
  if (av.verify) out.verify = av.verify;
  return out;
}

function buildEpicOut(epic) {
  const out = { id: epic.id, title: epic.title };
  assignNonEmpty(out, 'body', renderBody(epic.body));
  assignNonEmpty(out, 'labels', sanitizeLabels(epic.labels));
  return out;
}

function buildGatesOut(gates) {
  if (!gates || typeof gates !== 'object') return null;
  const out = {};
  if (typeof gates.baseline === 'string' && gates.baseline.length > 0) {
    out.baseline = gates.baseline;
  }
  if (typeof gates.config === 'string' && gates.config.length > 0) {
    out.config = gates.config;
  }
  return Object.keys(out).length > 0 ? out : null;
}

function validateSpec(spec, schemaPath) {
  const effectiveSchemaPath = schemaPath ?? DEFAULT_SCHEMA_PATH;
  if (!existsSync(effectiveSchemaPath)) {
    throw new Error(
      `[spec-renderer] schema not found at ${effectiveSchemaPath}`,
    );
  }
  const validator = getValidator(effectiveSchemaPath);
  if (!validator(spec)) {
    throw new SpecRenderValidationError(
      normaliseAjvErrors(validator.errors ?? []),
    );
  }
}

export function renderSpec(tickets, opts = {}) {
  validateRenderSpecInputs(tickets, opts);
  const { epic, gates, schemaPath, validate = true } = opts;

  const { bySlug, storySlugs } = indexTickets(tickets);
  const { layers } = layerStories(storySlugs, bySlug);
  const storySet = new Set(storySlugs);

  const stories = storySlugs.map((storySlug) =>
    buildStoryOut({
      story: bySlug.get(storySlug),
      layers,
      storySet,
    }),
  );

  const spec = { epic: buildEpicOut(epic), stories };
  const gatesOut = buildGatesOut(gates);
  if (gatesOut) spec.gates = gatesOut;

  if (validate) validateSpec(spec, schemaPath);
  return spec;
}
