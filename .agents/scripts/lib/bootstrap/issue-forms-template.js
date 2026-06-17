/**
 * bootstrap/issue-forms-template — Story #4227 (framework-gap)
 *
 * Generates GitHub **Issue Forms** (`.github/ISSUE_TEMPLATE/story.yml` and
 * `epic.yml`) derived from the canonical Story-body SSOT
 * (`lib/story-body/story-body.js`). The forms exist so a human filing a
 * Story/Epic in the GitHub web UI produces a body that round-trips through
 * the same `story-body.parse()` agents rely on — closing the
 * human↔agent ticket-shape gap.
 *
 * ## Why generated, not hand-authored
 *
 * Hand-authoring the forms would let the field headings drift from what
 * `parse()` expects. Instead the form field set is derived from a single
 * `HUMAN_INTENT_FIELDS` table here, and each field's heading is the exact
 * section name the parser maps (`goal` → `## Goal`, etc.). The CI
 * conformance lint (`lint-issue-body.js`) runs the real `parse()` against
 * human-opened issues so the form and the parser cannot silently drift —
 * the same model `ci-workflow-template.js` follows for `ci.yml`.
 *
 * ## Form fields ⊆ body schema
 *
 * The forms expose only the human **intent subset** — `goal`, `changes`,
 * `acceptance`, `verify`, `references`. Machine-managed sections (the
 * `<!-- meta: … -->` block, the frozen dispatch manifest, `agent::*`
 * transitions) are deliberately absent; the runtime fills those. The
 * relationship is "form fields ⊆ body schema," not "form == body."
 *
 * ## GitHub serialization contract (the lossy seam)
 *
 * GitHub Issue Forms render every `textarea`/`input` field as:
 *
 * ```text
 * ### {label}
 *
 * {value}
 * ```
 *
 * i.e. the field label becomes a level-3 heading (`###`), not the level-2
 * (`##`) the canonical serializer emits. `story-body.parse()` accepts both
 * heading levels (Story #4227 widened its heading regex), so a body
 * assembled from form output round-trips. This is the single point where
 * the form shape and the canonical serializer differ, and it is covered by
 * the round-trip test that feeds simulated GitHub output back through
 * `parse()`.
 *
 * @module bootstrap/issue-forms-template
 */

import fs from 'node:fs';
import path from 'node:path';

/**
 * Directory (relative to a project root) GitHub reads issue forms from.
 * Internal — the per-form path constants below are the exported surface.
 */
const ISSUE_TEMPLATE_RELATIVE_DIR = '.github/ISSUE_TEMPLATE';

/**
 * Relative paths of the two generated forms, surfaced as constants so tests
 * and the bootstrap caller assert the canonical write targets without
 * re-deriving them.
 */
export const STORY_FORM_RELATIVE_PATH = `${ISSUE_TEMPLATE_RELATIVE_DIR}/story.yml`;
export const EPIC_FORM_RELATIVE_PATH = `${ISSUE_TEMPLATE_RELATIVE_DIR}/epic.yml`;

/**
 * The human **intent subset** of the Story-body schema, in canonical
 * `parse()` section order. Each entry drives one form field. `heading` is
 * the exact section name `story-body.parse()` maps (case-insensitive); the
 * generated YAML uses it verbatim as the field `label` so GitHub's
 * `### {label}` render produces a heading the parser recognises.
 *
 * Machine-managed body fields (`wide`, `reason_to_exist`,
 * `estimated_test_files`, `depends_on` meta) are intentionally absent —
 * the runtime fills those. `depends_on` is exposed as a free-text input
 * that serializes to the `blocked by #N` footer `parse()` already reads.
 *
 * @type {Array<{
 *   id: string,
 *   heading: string,
 *   label: string,
 *   description: string,
 *   placeholder: string,
 *   required: boolean,
 *   kind: 'textarea'|'input',
 * }>}
 */
export const HUMAN_INTENT_FIELDS = [
  {
    id: 'goal',
    heading: 'Goal',
    label: 'Goal',
    description: 'One sentence: the purpose of this work.',
    placeholder:
      'Add a conformance lint that parses human-opened issue bodies.',
    required: true,
    kind: 'textarea',
  },
  {
    id: 'changes',
    heading: 'Changes',
    label: 'Changes',
    description:
      'Files or globs this work touches, one per line (e.g. `- src/foo.js: add handler`). Advisory — the binding contract is Acceptance/Verify.',
    placeholder: '- src/foo.js: add the handler\n- tests/foo.test.js: cover it',
    required: false,
    kind: 'textarea',
  },
  {
    id: 'acceptance',
    heading: 'Acceptance',
    label: 'Acceptance',
    description:
      'Observable, checkable criteria — one per line. This is the binding definition of done.',
    placeholder:
      '- The lint comments on a non-conformant body\n- A conformant body produces no comment',
    required: true,
    kind: 'textarea',
  },
  {
    id: 'verify',
    heading: 'Verify',
    label: 'Verify',
    description:
      'Exact commands that prove the work, one per line (annotate the tier, e.g. `(unit)`).',
    placeholder: '- npm test -- tests/foo.test.js (unit)',
    required: true,
    kind: 'textarea',
  },
  {
    id: 'references',
    heading: 'References',
    label: 'References',
    description: 'Read-only paths worth consulting, one per line. Optional.',
    placeholder: '- docs/architecture.md',
    required: false,
    kind: 'textarea',
  },
];

/**
 * Escape a string for safe embedding inside a double-quoted YAML scalar.
 * The generated YAML only ever quotes single-line scalars (labels,
 * descriptions, placeholders), so we escape backslashes, double quotes,
 * and collapse embedded newlines into the literal `\n` placeholder GitHub
 * renders verbatim in the form preview.
 *
 * @param {string} value
 * @returns {string}
 */
function yamlQuote(value) {
  const escaped = String(value)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n');
  return `"${escaped}"`;
}

/**
 * Render a single Issue-Form field block (a `textarea` or `input`) from a
 * {@link HUMAN_INTENT_FIELDS} descriptor. Indented to sit under the
 * top-level `body:` sequence.
 *
 * @param {(typeof HUMAN_INTENT_FIELDS)[number]} field
 * @returns {string}
 */
function renderFieldBlock(field) {
  return [
    `  - type: ${field.kind}`,
    `    id: ${field.id}`,
    '    attributes:',
    `      label: ${yamlQuote(field.label)}`,
    `      description: ${yamlQuote(field.description)}`,
    `      placeholder: ${yamlQuote(field.placeholder)}`,
    '    validations:',
    `      required: ${field.required}`,
  ].join('\n');
}

/**
 * Render the shared `depends_on` input. Its value serializes (by the
 * conformance lint / body assembler) into the `blocked by #N` footer lines
 * `parse()` already extracts, so it stays out of the heading-mapped field
 * set above.
 *
 * @returns {string}
 */
function renderDependsOnBlock() {
  return [
    '  - type: input',
    '    id: depends_on',
    '    attributes:',
    '      label: "Blocked by"',
    '      description: "Comma-separated issue refs this work depends on (e.g. #123, #456). Optional."',
    '      placeholder: "#123, #456"',
    '    validations:',
    '      required: false',
  ].join('\n');
}

/**
 * @typedef {object} IssueFormOptions
 * @property {string} [entryStateLabel='agent::review-spec'] - Lifecycle
 *   entry-state label auto-applied alongside the `type::*` label so
 *   human-filed tickets land in the same lane as agent-created ones.
 * @property {string} [projectName] - Optional repo/project name woven into
 *   the form description. Purely cosmetic.
 */

/**
 * Shared header banner stamped on every generated form so the provenance
 * (and the "regenerate, don't hand-edit" rule) travels with the file.
 */
const GENERATED_BANNER =
  '# Generated by agents-bootstrap-github (Story #4227) from the Story-body SSOT\n' +
  '# (.agents/scripts/lib/story-body/story-body.js). Do NOT hand-edit the\n' +
  '# field set — field headings must stay in lockstep with story-body.parse().\n' +
  '# Re-run /agents-bootstrap-github to refresh. The CI conformance lint\n' +
  '# (lint-issue-body.js) is the drift guard between this form and the parser.';

/**
 * Render the GitHub Issue Form YAML for a given ticket type (`story` or
 * `epic`). Both forms share the identical human-intent field set — the
 * difference is the `type::` label and the form name/description — because
 * `parse()` is type-agnostic over the body shape.
 *
 * The output is deterministic so the round-trip + idempotency tests assert
 * on its exact shape.
 *
 * @param {'story'|'epic'} ticketType
 * @param {IssueFormOptions} [opts]
 * @returns {string}
 */
export function renderIssueForm(ticketType, opts = {}) {
  if (ticketType !== 'story' && ticketType !== 'epic') {
    throw new Error(
      `renderIssueForm: ticketType must be 'story' or 'epic', got ${ticketType}`,
    );
  }
  const entryStateLabel = opts.entryStateLabel ?? 'agent::review-spec';
  const typeLabel = `type::${ticketType}`;
  const titleCase = ticketType === 'story' ? 'Story' : 'Epic';
  const projectSuffix = opts.projectName ? ` for ${opts.projectName}` : '';

  const fieldBlocks = HUMAN_INTENT_FIELDS.map(renderFieldBlock).join('\n');

  return `${GENERATED_BANNER}
name: ${titleCase}
description: File a ${titleCase} that round-trips through the Mandrel body parser${projectSuffix}.
title: "[${titleCase}]: "
labels:
  - ${typeLabel}
  - ${entryStateLabel}
body:
  - type: markdown
    attributes:
      value: |
        Fill the fields below. They serialize to the canonical Story body
        the framework parses — keep each section's content under its own
        heading. Machine-managed sections (dispatch manifest, lifecycle
        transitions) are added by the runtime; you do not author them here.
${fieldBlocks}
${renderDependsOnBlock()}
`;
}

/**
 * Assemble a canonical Story-body markdown string from the per-field values
 * a GitHub Issue Form yields (keyed by field `id`). This is the inverse of
 * the form: it reconstructs what GitHub *would* serialize, using the
 * canonical `## {Heading}` form so the result feeds straight into
 * `story-body.parse()`. The conformance lint and the round-trip test use it
 * to prove the form → parser contract without a live GitHub call.
 *
 * @param {Record<string, string>} values - Field id → raw textarea/input value.
 * @returns {string} Canonical markdown body.
 */
export function assembleBodyFromFormValues(values = {}) {
  const sections = [];
  for (const field of HUMAN_INTENT_FIELDS) {
    const raw = values[field.id];
    if (typeof raw !== 'string' || raw.trim().length === 0) continue;
    sections.push(`## ${field.heading}\n${raw.trim()}`);
  }
  let body = sections.join('\n\n');

  const dependsRaw = values.depends_on;
  if (typeof dependsRaw === 'string' && dependsRaw.trim().length > 0) {
    const refs = dependsRaw
      .split(',')
      .map((r) => r.trim())
      .filter(Boolean)
      .map((r) => (r.startsWith('#') ? r : `#${r.replace(/^#/, '')}`));
    if (refs.length > 0) {
      const footer = ['---', ...refs.map((r) => `blocked by ${r}`)].join('\n');
      body = `${body}\n\n${footer}`;
    }
  }
  return body;
}

/**
 * Relative path of the issue-body conformance workflow — the drift guard
 * that runs `story-body.parse()` against human-opened tickets.
 */
export const CONFORMANCE_WORKFLOW_RELATIVE_PATH =
  '.github/workflows/issue-body-conformance.yml';

/**
 * Render the CI workflow that runs the issue-body conformance lint
 * (`lint-issue-body.js`) on opened/edited `type::story` / `type::epic`
 * issues. This is the mechanism that prevents the generated forms and
 * `story-body.parse()` from silently drifting (Story #4227 acceptance).
 * Deterministic so the bootstrap test asserts its exact shape. Internal —
 * exposed to consumers only through {@link ensureIssueForms}.
 *
 * @returns {string}
 */
function renderConformanceWorkflow() {
  return `# Issue-body conformance lint (Story #4227).
#
# Generated by agents-bootstrap-github. Runs the canonical story-body parser
# against human-opened type::story / type::epic issues and comments when the
# body does not round-trip, instead of letting the supported human entry
# points (e.g. /plan from an existing Epic ID) fail silently later. The lint
# informs; it never fails the issue. Re-run /agents-bootstrap-github to refresh.
name: Issue Body Conformance

on:
  issues:
    types: [opened, edited]

permissions:
  contents: read
  issues: write

concurrency:
  group: issue-body-conformance-\${{ github.event.issue.number }}
  cancel-in-progress: true

jobs:
  conformance:
    name: Parse issue body
    runs-on: ubuntu-latest
    steps:
      - name: Checkout Code
        uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '22'

      - name: Lint issue body
        env:
          GH_TOKEN: \${{ github.token }}
          ISSUE_NUMBER: \${{ github.event.issue.number }}
          GITHUB_REPOSITORY: \${{ github.repository }}
        run: node .agents/scripts/lint-issue-body.js
`;
}

/**
 * Write (or refresh) both issue forms into a project checkout. Idempotent at
 * the byte level — mirrors {@link ensureCiWorkflow}'s contract:
 *
 * - file absent → `created`
 * - byte-identical → `unchanged`
 * - operator-edited (differs from the rendered template) → `custom-skip`
 *   (the existing file is preserved; `rendered` is returned so the caller
 *   can offer a diff)
 *
 * Network-free; safe under tests with a tmp `projectRoot`.
 *
 * @param {object} args
 * @param {string} args.projectRoot
 * @param {IssueFormOptions} [args.options]
 * @param {boolean} [args.write=true] - When `false`, compute the would-be
 *   actions without touching disk (dry-run).
 * @returns {{ forms: Array<{ type: 'story'|'epic'|'conformance-workflow',
 *             action: 'created'|'unchanged'|'custom-skip',
 *             path: string, rendered: string }> }}
 */
export function ensureIssueForms(args) {
  const projectRoot = args.projectRoot;
  const options = args.options ?? {};
  const write = args.write !== false;

  // Each target pairs a ticket-type key with the rendered body. The
  // conformance workflow is materialized alongside the forms because it is
  // the forms' drift guard — they ship as one unit.
  const targets = [
    {
      type: 'story',
      rel: STORY_FORM_RELATIVE_PATH,
      rendered: renderIssueForm('story', options),
    },
    {
      type: 'epic',
      rel: EPIC_FORM_RELATIVE_PATH,
      rendered: renderIssueForm('epic', options),
    },
    {
      type: 'conformance-workflow',
      rel: CONFORMANCE_WORKFLOW_RELATIVE_PATH,
      rendered: renderConformanceWorkflow(),
    },
  ];

  const forms = targets.map(({ type, rel, rendered }) => {
    const target = path.join(projectRoot, rel);

    if (!fs.existsSync(target)) {
      if (write) {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, rendered, 'utf8');
      }
      return { type, action: 'created', path: target, rendered };
    }

    const existing = fs.readFileSync(target, 'utf8');
    if (existing === rendered) {
      return { type, action: 'unchanged', path: target, rendered };
    }
    return { type, action: 'custom-skip', path: target, rendered };
  });

  return { forms };
}
