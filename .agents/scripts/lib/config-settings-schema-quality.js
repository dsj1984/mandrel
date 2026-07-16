/* node:coverage ignore file -- AJV schema declaration (data-as-code); MI < 70 is inherent to large flat schema literals, no business logic to test */

// ---------------------------------------------------------------------------
// delivery.quality.* sub-schemas — extracted from
// config-settings-schema-delivery.js to keep each schema module above the
// maintainability floor (refs #3457). Pure declarative AJV fragments; the
// resolved QUALITY_SCHEMA is byte-for-byte equivalent in effect.
// ---------------------------------------------------------------------------

// `delivery.quality.gates.<tier>` sub-schemas live in their own module
// (Story #1737); see `config/gates/index.js` for the seven gate shapes
// and the shared { kind, value } tolerance + workspace-keyed floors
// fragments. Story #2987 split the former `config-gates-schema.js`
// aggregate into per-gate files under `config/gates/`.
import { GATES_SCHEMA } from './config/gates/index.js';

// Story #4531: miDropMustRefactor (here) and autoRefresh.miDropCap (below)
// were retired. Both were schema-validated, defaulted, and resolved, but
// never consumed by the gate they were named for — quality-preview.js's
// computeExitCode short-circuits on miExit (derived from the ALREADY-
// consumed delivery.quality.gates.maintainability.tolerance) before either
// knob is ever read. maintainability.tolerance is now the single documented
// MI-drop control. See lib/migrations/index.js for the consumer-config
// migration that strips these keys on upgrade (additionalProperties: false
// below means a leftover key is a hard AJV failure, not a silent no-op).
const CODING_GUARDRAILS_SCHEMA = {
  type: 'object',
  properties: {
    cyclomaticFlag: { type: 'integer', minimum: 1 },
    cyclomaticMustFix: { type: 'integer', minimum: 1 },
    requireSiblingTest: { type: 'boolean' },
  },
  additionalProperties: false,
};

const AUTO_REFRESH_SCHEMA = {
  type: 'object',
  properties: {
    enabled: { type: 'boolean' },
    crapJumpCap: { type: 'number', minimum: 0 },
    scope: { type: 'string', enum: ['diff', 'full'] },
  },
  additionalProperties: false,
};

/**
 * `delivery.quality.baselineEpsilon` — per-kind epsilon for
 * s-stability-epsilon (Story #1964). Sub-epsilon row deltas resolve to
 * the prior bytes so env variance never rewrites the on-disk baseline.
 */
const BASELINE_EPSILON_SCHEMA = {
  type: 'object',
  properties: {
    maintainability: { type: 'number', minimum: 0 },
    crap: { type: 'number', minimum: 0 },
    coverage: { type: 'number', minimum: 0 },
    mutation: { type: 'number', minimum: 0 },
    lint: { type: 'number', minimum: 0 },
    lighthouse: { type: 'number', minimum: 0 },
    'bundle-size': { type: 'number', minimum: 0 },
    duplication: { type: 'number', minimum: 0 },
  },
  additionalProperties: false,
};

/**
 * `delivery.quality.formatAutofix` — bounded-timeout knob for the
 * close-time `npx biome format --write` spawn (Story #2165). Mirrors
 * `gates.coverage.timeoutMs` (Story #2142): a SIGKILL fired at the budget
 * boundary maps to exit 124 so the close orchestrator can flip the Story
 * to `agent::blocked` with a friction comment.
 */
const FORMAT_AUTOFIX_SCHEMA = {
  type: 'object',
  properties: {
    timeoutMs: { type: 'integer', minimum: 1 },
  },
  additionalProperties: false,
};

/**
 * `delivery.quality` — uniform per-gate shape (Story #1737).
 *
 * Every gate lives under `gates.<tier>` and shares the four-field base:
 * `{ enabled, baselinePath, tolerance: { kind, value }, floors: { "*": {...} } }`.
 * Shared scoping lives at the block root (`gateScoping`). The legacy
 * top-level `crap`, `maintainability`, `qualityFloors`, and `baselines`
 * keys are gone — replaced by the gate-shaped equivalents.
 */
export const QUALITY_SCHEMA = {
  type: 'object',
  properties: {
    gateScoping: {
      type: 'object',
      properties: {
        scope: { type: 'string', enum: ['diff', 'full'] },
        diffRef: { type: 'string', minLength: 1 },
      },
      additionalProperties: false,
    },
    gates: GATES_SCHEMA,
    formatAutofix: FORMAT_AUTOFIX_SCHEMA,
    codingGuardrails: CODING_GUARDRAILS_SCHEMA,
    autoRefresh: AUTO_REFRESH_SCHEMA,
    baselineEpsilon: BASELINE_EPSILON_SCHEMA,
    // Story #4495. Fail-closed baseline-enforcement policy for the unified
    // check-baselines close-validation gate. Default false: a consumer that
    // enables baseline gates but has not committed baseline artifacts under
    // baselines/ gets a clean skip-with-reason from buildDefaultGates rather
    // than a deterministic first-try close failure. Set true to keep the gate
    // registered so an absent baseline artifact fails close-validation with a
    // preflight hint (the fail-closed posture, analogous to
    // delivery.ci.requireChecks).
    requireBaselines: { type: 'boolean' },
    // Navigability lens + post-wave integration gate config (Epic #4131,
    // F2/F3/F1/F4). Read by audit-suite/selector.js (route globs) and the
    // deliver-epic.md Phase 6.5 gate (journey suite). Opt-in: absent or empty
    // routeGlobs degrades to a silent no-op.
    navigability: {
      type: 'object',
      properties: {
        routeGlobs: { type: 'array', items: { type: 'string' } },
        navRegistry: { type: 'array', items: { type: 'string' } },
        journeySuite: { type: 'string' },
      },
      additionalProperties: false,
    },
  },
  additionalProperties: false,
};

/**
 * `delivery.codeReview` — review-provider chain + bounded-retry knobs for
 * the /deliver code-review ceremony (Story-close and plan-run close).
 *
 * `autoFixSeverity` (Story #4399) is the threshold that governs which
 * findings the host-LLM focused-fix routing remediates on-branch —
 * `medium` (default) routes 🔴/🟠/🟡 while 🟢 still graduates, `high`
 * reproduces the pre-4399 Critical/High-only routing.
 */
export const CODE_REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    // Story #2825 (Epic #2815) seeded the pluggable review backend
    // with `native`; Story #2830 added `codex` (the
    // `openai/codex-plugin-cc` Claude Code plugin). The codex
    // adapter probes for `/codex:review` at factory construction and
    // hard-fails with remediation when absent — there is no silent
    // fallback to native. `providerConfig` is an open-shape escape
    // hatch reserved for adapter-specific options.
    //
    // Story #2871 added `security-review` to the inline registry plus
    // the `providers: []` chain shape. Chain entries can also reference
    // the `ultrareview` manual-prompt provider via `manualPrompt: true`.
    // When `providers` is unset or empty, the factory defaults to
    // `[{ name: 'native' }]`.
    providers: {
      type: 'array',
      items: {
        type: 'object',
        required: ['name'],
        properties: {
          name: {
            type: 'string',
            enum: ['native', 'codex', 'security-review', 'ultrareview'],
          },
          scopes: {
            type: 'array',
            items: { type: 'string', enum: ['story', 'epic'] },
          },
          optional: { type: 'boolean', default: false },
          manualPrompt: { type: 'boolean', default: false },
          when: {
            type: 'object',
            properties: {
              label: { type: 'string', minLength: 1 },
              labelAny: {
                type: 'array',
                items: { type: 'string', minLength: 1 },
                minItems: 1,
              },
            },
            additionalProperties: false,
          },
        },
        additionalProperties: false,
      },
    },
    providerConfig: { type: 'object', additionalProperties: true },
    maxFixAttempts: { type: 'integer', minimum: 0 },
    maxFixScopeFiles: { type: 'integer', minimum: 1 },
    autoFixSeverity: { type: 'string', enum: ['high', 'medium'] },
  },
  additionalProperties: false,
};
