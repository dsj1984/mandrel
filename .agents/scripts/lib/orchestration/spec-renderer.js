/**
 * lib/orchestration/spec-renderer.js — tickets.json → epic-spec.yaml
 * projection (Story #1495 / Task #1522, parent Story slug
 * `story-spec-renderer`, Epic #1182).
 *
 * The decomposer (`epic-plan-decompose-author`) produces a flat array of
 * ticket objects of three shapes (feature / story / task) keyed by
 * stable `slug`s and linked by `parent_slug` + `depends_on`. The spec
 * reconciler (Wave 1 of Epic #1182) instead consumes the **declarative
 * structural** representation defined by
 * `.agents/schemas/epic-spec.schema.json` — a nested `{ epic, features:
 * [{ stories: [{ tasks: [...] }] }] }` tree with Story-level `wave` and
 * `dependsOn` projected from the decomposer's edges.
 *
 * `renderSpec(tickets, opts)` is the pure projection between those two
 * shapes. It:
 *
 *   1. Indexes the flat array by slug, partitioning into features /
 *      stories / tasks.
 *   2. Filters `depends_on` edges down to **inter-Story** dependencies
 *      (Task-level `depends_on` is intra-Story positional ordering and
 *      collapses into `tasks[]` order; cross-Story Task edges are
 *      forbidden by the decomposer contract — see
 *      `lib/orchestration/ticket-validator.js`).
 *   3. Layers Stories into waves via `Graph.assignLayers` (depth in the
 *      story-only DAG = wave index). Stories with no inbound edges sit
 *      at `wave: 0`, matching the wave-runner's runtime convention
 *      (`build-wave-dag.js` produces the same layering at dispatch time
 *      from the live GH state, so the spec's waves are observationally
 *      identical to what dispatch will compute).
 *   4. Walks the hierarchy in decomposer-declared order (feature →
 *      story → task), preserving the order the LLM emitted so the
 *      reconciler's diff stays human-readable.
 *   5. Strips `agent::*` labels from every entity. The decomposer
 *      doesn't normally write them, but they can leak via reverse-
 *      bootstrap from live GH state — and the schema forbids them
 *      (the reconciler explicitly enforces the structural/agent label
 *      split).
 *   6. Validates the produced object against the spec schema before
 *      returning. A renderer bug that emits a malformed spec is caught
 *      synchronously rather than failing later in `loadSpec`.
 *
 * Pure — no I/O. The validator is compiled once per process and cached
 * by absolute schema path (same cache the loader uses internally; this
 * module re-derives the path from its own location so the renderer
 * imposes no new resolution surface).
 *
 * Round-trip: parse a tickets fixture → render → write to YAML →
 * reload via `loadSpec` → the reloaded shape is structurally identical
 * to the renderer output (modulo YAML's omission of `undefined` keys).
 * Verified by `tests/scripts/spec-renderer.test.js`.
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
 * Convert a decomposer body value into a spec `body` string. The
 * decomposer schema admits two shapes:
 *
 *   - Features / Stories: `body` is a short string.
 *   - Tasks: `body` is a structured object
 *     (`{ goal, changes[], acceptance[], verify[] }`) and tests / docs
 *     are produced from it via `task-body-renderer`.
 *
 * The spec schema only models `body` as a string. For structured Task
 * bodies, render a compact markdown projection that preserves the
 * original sections so the reconciler's downstream issue-body apply
 * produces the same body the executing agent reads. For string bodies,
 * pass through unchanged. `undefined` / empty values drop the field
 * (the schema allows omission).
 *
 * The renderer does NOT round-trip structured bodies — by design, the
 * spec is the canonical surface once it's authored, and structured
 * Task bodies collapse into the markdown form on first projection.
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
  if (typeof body.goal === 'string' && body.goal.length > 0) {
    sections.push(`## Goal\n${body.goal}`);
  }
  if (Array.isArray(body.changes) && body.changes.length > 0) {
    const items = body.changes.map((c) => `- ${String(c)}`).join('\n');
    sections.push(`## Changes\n${items}`);
  }
  if (Array.isArray(body.acceptance) && body.acceptance.length > 0) {
    const items = body.acceptance.map((a) => `- [ ] ${String(a)}`).join('\n');
    sections.push(`## Acceptance\n${items}`);
  }
  if (Array.isArray(body.verify) && body.verify.length > 0) {
    const items = body.verify.map((v) => `- ${String(v)}`).join('\n');
    sections.push(`## Verify\n${items}`);
  }
  return sections.length > 0 ? sections.join('\n\n') : undefined;
}

function assignNonEmpty(target, key, value) {
  if (value === undefined) return;
  target[key] = value;
}

/**
 * Partition the flat ticket array into per-type maps keyed by slug.
 * Returns the ordered slug lists alongside the lookup map so the
 * renderer can walk the hierarchy in the decomposer's emit order
 * (parents-before-children is guaranteed by the validator's
 * topological sort, but we don't need that invariant here — we walk
 * features in array order, then look up their children by parent_slug
 * in the order the decomposer emitted them).
 *
 * @param {Array<object>} tickets
 */
function indexTickets(tickets) {
  const bySlug = new Map();
  const featureSlugs = [];
  const storySlugs = [];
  const taskSlugs = [];

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
    if (t.type === 'feature') featureSlugs.push(slug);
    else if (t.type === 'story') storySlugs.push(slug);
    else if (t.type === 'task') taskSlugs.push(slug);
    else {
      throw new Error(
        `[spec-renderer] ticket "${slug}" has unknown type "${t.type}"`,
      );
    }
  }
  return { bySlug, featureSlugs, storySlugs, taskSlugs };
}

/**
 * Build the slug-keyed story dependency graph used for wave layering.
 * Drops every edge that does not reference another story slug in the
 * same Epic (defensive — Tasks targeting Stories via depends_on, or
 * Story slugs that were typo'd, both collapse here rather than
 * polluting the wave count).
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
 *   decomposer Skill (`type` ∈ {feature, story, task}, `slug`,
 *   `parent_slug`, `depends_on`, `title`, `body`, `labels`).
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
 * @returns {object} spec — `{ epic, features, gates? }` matching
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

function bucketChildren({ tickets, storySlugs, bySlug }) {
  const storiesByFeature = new Map();
  for (const slug of storySlugs) {
    const story = bySlug.get(slug);
    const parent = story.parent_slug;
    if (typeof parent !== 'string' || !bySlug.has(parent)) continue;
    if (!storiesByFeature.has(parent)) storiesByFeature.set(parent, []);
    storiesByFeature.get(parent).push(slug);
  }
  const tasksByStory = new Map();
  for (const t of tickets) {
    if (!t || t.type !== 'task') continue;
    const parent = t.parent_slug;
    if (typeof parent !== 'string' || !bySlug.has(parent)) continue;
    if (!tasksByStory.has(parent)) tasksByStory.set(parent, []);
    tasksByStory.get(parent).push(t.slug);
  }
  return { storiesByFeature, tasksByStory };
}

function buildTaskOut(task) {
  const out = { slug: task.slug, title: task.title };
  assignNonEmpty(out, 'body', renderBody(task.body));
  assignNonEmpty(out, 'labels', sanitizeLabels(task.labels));
  return out;
}

function buildStoryOut({ story, taskSlugs, bySlug, layers, storySet }) {
  const tasks = taskSlugs.map((slug) => buildTaskOut(bySlug.get(slug)));
  const deps = Array.isArray(story.depends_on) ? story.depends_on : [];
  const dependsOn = [
    ...new Set(deps.filter((d) => storySet.has(d) && d !== story.slug)),
  ];

  const out = {
    slug: story.slug,
    title: story.title,
    wave: layers.get(story.slug) ?? 0,
    tasks,
  };
  assignNonEmpty(out, 'body', renderBody(story.body));
  if (dependsOn.length > 0) out.dependsOn = dependsOn;
  assignNonEmpty(out, 'labels', sanitizeLabels(story.labels));
  return out;
}

function buildFeatureOut({
  feature,
  storySlugs,
  bySlug,
  layers,
  storySet,
  tasksByStory,
}) {
  const stories = storySlugs.map((storySlug) =>
    buildStoryOut({
      story: bySlug.get(storySlug),
      taskSlugs: tasksByStory.get(storySlug) ?? [],
      bySlug,
      layers,
      storySet,
    }),
  );
  const out = { slug: feature.slug, title: feature.title, stories };
  assignNonEmpty(out, 'body', renderBody(feature.body));
  assignNonEmpty(out, 'labels', sanitizeLabels(feature.labels));
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

  const { bySlug, featureSlugs, storySlugs } = indexTickets(tickets);
  const { layers } = layerStories(storySlugs, bySlug);
  const { storiesByFeature, tasksByStory } = bucketChildren({
    tickets,
    storySlugs,
    bySlug,
  });
  const storySet = new Set(storySlugs);

  const features = featureSlugs.map((featureSlug) =>
    buildFeatureOut({
      feature: bySlug.get(featureSlug),
      storySlugs: storiesByFeature.get(featureSlug) ?? [],
      bySlug,
      layers,
      storySet,
      tasksByStory,
    }),
  );

  const spec = { epic: buildEpicOut(epic), features };
  const gatesOut = buildGatesOut(gates);
  if (gatesOut) spec.gates = gatesOut;

  if (validate) validateSpec(spec, schemaPath);
  return spec;
}
