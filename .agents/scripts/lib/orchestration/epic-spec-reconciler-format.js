/**
 * lib/orchestration/epic-spec-reconciler-format.js — human-readable plan
 * renderer for the epic-spec reconciler (Story #1492 / Task #1511).
 *
 * Takes a `Plan` (from `epic-spec-reconciler-diff.js`) and returns a
 * deterministic Markdown block suitable for:
 *
 *   • CLI dry-run output (`reconciler --dry-run`).
 *   • Sticky comment bodies on the Epic ticket (apply preview).
 *   • Test fixtures that snapshot a plan's rendering.
 *
 * ## Determinism guarantees
 *
 *   • Operations are emitted in four fixed sections — Create, Update,
 *     Close, Relink — in that order. Sections always appear, even when
 *     empty (the empty marker is `_no operations_`), so the structure
 *     of the output is stable across plans.
 *   • Within each section, operations are sorted by slug. This matches
 *     the sort the diff engine already applies, so the formatter never
 *     reorders relative to the plan input; the assertion just guards
 *     callers that hand-build a plan.
 *   • Each operation line names the slug, the target issue number (when
 *     known), and the changed fields. Changed-field keys are sorted so
 *     `body, labels, title` always appears in that order.
 *   • Label arrays are pre-sorted by the operation constructors, so the
 *     output never reorders them.
 *
 * The formatter performs no I/O and consumes no external state.
 */

import { isPlan } from './epic-spec-reconciler-ops.js';

const HEADINGS = Object.freeze({
  creates: '## Creates',
  updates: '## Updates',
  closes: '## Closes',
  relinks: '## Relinks',
});

/**
 * Render an issue-number suffix (e.g. ` (#123)`) when known, else empty.
 *
 * @param {number|undefined} issueNumber
 * @returns {string}
 */
function issueSuffix(issueNumber) {
  if (typeof issueNumber !== 'number' || !Number.isFinite(issueNumber)) {
    return '';
  }
  return ` (#${issueNumber})`;
}

/**
 * Format a single CreateOp as a Markdown bullet line.
 *
 *   - `slug` [entity]: <title> [labels=…] [parent=…] [wave=…] [dependsOn=…]
 *
 * @param {import('./epic-spec-reconciler-ops.js').CreateOp} op
 * @returns {string}
 */
function formatCreate(op) {
  const parts = [`- \`${op.slug}\` [${op.entity}]: ${op.title}`];
  if (op.labels?.length) parts.push(`labels=[${op.labels.join(', ')}]`);
  if (op.parentSlug) parts.push(`parent=${op.parentSlug}`);
  if (typeof op.wave === 'number') parts.push(`wave=${op.wave}`);
  if (op.dependsOn?.length)
    parts.push(`dependsOn=[${op.dependsOn.join(', ')}]`);
  return parts.join(' · ');
}

/**
 * Render a single field change as `field: <before> → <after>`. Strings
 * are bounded so the line stays single-line-readable; arrays render as
 * bracketed comma-separated lists; objects fall back to JSON.
 *
 * @param {string} field
 * @param {{before: unknown, after: unknown}} change
 * @returns {string}
 */
function formatChange(field, change) {
  return `${field}: ${stringifyValue(change.before)} → ${stringifyValue(change.after)}`;
}

/**
 * Render a single primitive/array/object for the dry-run output. Strings
 * are quoted when they contain whitespace or are empty, so a label-strip
 * (`"x" → ""`) is visually obvious in the rendered output.
 *
 * @param {unknown} value
 * @returns {string}
 */
function stringifyValue(value) {
  if (value === null) return 'null';
  if (value === undefined) return '∅';
  if (Array.isArray(value)) {
    return `[${value.map(stringifyValue).join(', ')}]`;
  }
  if (typeof value === 'string') {
    if (value === '' || /\s/.test(value)) return JSON.stringify(value);
    return value;
  }
  if (typeof value === 'object') {
    return JSON.stringify(value);
  }
  return String(value);
}

/**
 * Format a single UpdateOp.
 *
 *   - `slug` [entity] (#123): body: "…" → "…", title: "…" → "…"
 *
 * @param {import('./epic-spec-reconciler-ops.js').UpdateOp} op
 * @returns {string}
 */
function formatUpdate(op) {
  const fields = Object.keys(op.changes ?? {}).sort();
  const rendered = fields.map((f) => formatChange(f, op.changes[f]));
  const head = `- \`${op.slug}\` [${op.entity}]${issueSuffix(op.issueNumber)}`;
  if (rendered.length === 0) return `${head}: (no changes)`;
  return `${head}: ${rendered.join('; ')}`;
}

/**
 * Format a single CloseOp.
 *
 *   - `slug` [entity] (#123): <title>
 *
 * @param {import('./epic-spec-reconciler-ops.js').CloseOp} op
 * @returns {string}
 */
function formatClose(op) {
  const head = `- \`${op.slug}\` [${op.entity}]${issueSuffix(op.issueNumber)}`;
  return op.title ? `${head}: ${op.title}` : head;
}

/**
 * Format a single RelinkOp.
 *
 *   - `slug` [entity] (#123): parent: a → b · dependsOn: [x] → [y, z]
 *
 * @param {import('./epic-spec-reconciler-ops.js').RelinkOp} op
 * @returns {string}
 */
function formatRelink(op) {
  const head = `- \`${op.slug}\` [${op.entity}]${issueSuffix(op.issueNumber)}`;
  const parts = [];
  if (op.parent) {
    parts.push(
      `parent: ${stringifyValue(op.parent.before)} → ${stringifyValue(op.parent.after)}`,
    );
  }
  if (op.dependsOn) {
    parts.push(
      `dependsOn: ${stringifyValue(op.dependsOn.before)} → ${stringifyValue(op.dependsOn.after)}`,
    );
  }
  if (parts.length === 0) return `${head}: (no edge changes)`;
  return `${head}: ${parts.join(' · ')}`;
}

/**
 * Sort operations by slug; defensive copy so we never mutate the caller's
 * plan even if they handed in an unsorted bucket.
 *
 * @template {{slug: string}} T
 * @param {T[]} ops
 * @returns {T[]}
 */
function sortBySlug(ops) {
  return [...ops].sort((a, b) => a.slug.localeCompare(b.slug));
}

/**
 * Render a single section (heading + body). Always emits the heading so
 * the four-section structure is invariant.
 *
 * @param {string} heading
 * @param {string[]} lines
 * @returns {string}
 */
function renderSection(heading, lines) {
  if (lines.length === 0) {
    return `${heading}\n\n_no operations_`;
  }
  return `${heading}\n\n${lines.join('\n')}`;
}

/**
 * Header line for the rendered plan.
 *
 * @param {import('./epic-spec-reconciler-ops.js').Plan} plan
 * @returns {string}
 */
function renderHeader(plan) {
  const total =
    plan.creates.length +
    plan.updates.length +
    plan.closes.length +
    plan.relinks.length;
  if (total === 0) {
    return '# Reconciler plan — no operations (idempotent)';
  }
  return `# Reconciler plan — ${total} operation${total === 1 ? '' : 's'}`;
}

/**
 * Render `plan` to a deterministic Markdown block. The output is stable
 * for a given plan; rendering an empty plan returns the canonical
 * "no operations" form so consumers can detect idempotent reconciles
 * by string equality.
 *
 * @param {import('./epic-spec-reconciler-ops.js').Plan} plan
 * @returns {string}
 */
export function formatPlan(plan) {
  if (!isPlan(plan)) {
    throw new TypeError(
      'formatPlan: input is not a Plan (expected { creates, updates, closes, relinks })',
    );
  }
  const sections = [
    renderHeader(plan),
    renderSection(HEADINGS.creates, sortBySlug(plan.creates).map(formatCreate)),
    renderSection(HEADINGS.updates, sortBySlug(plan.updates).map(formatUpdate)),
    renderSection(HEADINGS.closes, sortBySlug(plan.closes).map(formatClose)),
    renderSection(HEADINGS.relinks, sortBySlug(plan.relinks).map(formatRelink)),
  ];
  return sections.join('\n\n');
}
