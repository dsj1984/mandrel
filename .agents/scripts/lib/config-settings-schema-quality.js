/* node:coverage ignore file -- AJV schema declaration (data-as-code); MI < 70 is inherent to large flat schema literals, no business logic to test */

// ---------------------------------------------------------------------------
// delivery.quality.* sub-schemas — extracted from
// config-settings-schema-delivery.js to keep each schema module above the
// maintainability floor (refs #3457). Pure declarative AJV fragments; the
// resolved QUALITY_SCHEMA is byte-for-byte equivalent in effect.
// ---------------------------------------------------------------------------

import { GATES_SCHEMA } from './config/gates/index.js';
// `delivery.quality.gates.<tier>` sub-schemas live in their own module
// (Story #1737); see `config/gates/index.js` for the seven gate shapes
// and the shared { kind, value } tolerance + workspace-keyed floors
// fragments. Story #2987 split the former `config-gates-schema.js`
// aggregate into per-gate files under `config/gates/`.
import {
  BASELINE_EPSILON_DEFAULTS,
  CODING_GUARDRAILS_DEFAULTS,
} from './config/quality.js';
import { DEFAULT_CODE_REVIEW } from './config/runners.js';

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
  description:
    'Authoring-time cyclomatic-complexity advisories surfaced by the quality-preview pre-commit gate.',
  properties: {
    cyclomaticFlag: {
      type: 'integer',
      minimum: 1,
      description:
        'Cyclomatic complexity at which a new or changed method is flagged for a refactor look.',
      default: CODING_GUARDRAILS_DEFAULTS.cyclomaticFlag,
    },
    requireSiblingTest: {
      type: 'boolean',
      description:
        'When true, a new source file with no colocated sibling test is reported by the guardrails pass.',
      default: CODING_GUARDRAILS_DEFAULTS.requireSiblingTest,
    },
  },
  additionalProperties: false,
};

const AUTO_REFRESH_SCHEMA = {
  type: 'object',
  description:
    'Baseline-attribution auto-refresh: when a gate can prove a regression is a legitimate consequence of the diff, it rewrites the baseline instead of blocking.',
  properties: {
    enabled: {
      type: 'boolean',
      description:
        'Master switch for the auto-refresh path. When false, every baseline refresh is a deliberate operator action.',
      default: true,
    },
    crapJumpCap: {
      type: 'number',
      minimum: 0,
      description:
        'Largest single-row CRAP jump the auto-refresh will absorb. A larger jump is reported as a regression rather than rewritten.',
      default: 5,
    },
    scope: {
      type: 'string',
      enum: ['diff', 'full'],
      description:
        'Whether an auto-refresh rescores only the changed files (`diff`) or every file in the target dirs (`full`).',
      default: 'diff',
    },
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
  description:
    'Per-kind epsilon for s-stability-epsilon (Story #1964). Sub-epsilon row deltas resolve to prior bytes so env variance does not rewrite the on-disk baseline.',
  properties: {
    maintainability: {
      type: 'number',
      minimum: 0,
      default: BASELINE_EPSILON_DEFAULTS.maintainability,
    },
    crap: {
      type: 'number',
      minimum: 0,
      default: BASELINE_EPSILON_DEFAULTS.crap,
    },
    coverage: {
      type: 'number',
      minimum: 0,
      default: BASELINE_EPSILON_DEFAULTS.coverage,
    },
    mutation: {
      type: 'number',
      minimum: 0,
      default: BASELINE_EPSILON_DEFAULTS.mutation,
    },
    lint: {
      type: 'number',
      minimum: 0,
      default: BASELINE_EPSILON_DEFAULTS.lint,
    },
    lighthouse: {
      type: 'number',
      minimum: 0,
      default: BASELINE_EPSILON_DEFAULTS.lighthouse,
    },
    'bundle-size': {
      type: 'number',
      minimum: 0,
      default: BASELINE_EPSILON_DEFAULTS['bundle-size'],
    },
    duplication: {
      type: 'number',
      minimum: 0,
      default: BASELINE_EPSILON_DEFAULTS.duplication,
    },
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
  description:
    'Bounded-timeout knob for the close-time `npx biome format --write` spawn (Story #2165). A SIGKILL fired at the budget boundary maps to exit 124 so the close orchestrator can flip the Story to `agent::blocked` with a friction comment.',
  properties: {
    timeoutMs: {
      type: 'integer',
      minimum: 1,
      description: 'Timeout (ms) for the format-write spawn.',
      default: 60000,
    },
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
  description:
    'Quality-gate configuration. Every gate lives under `gates.<tier>` and shares the same `{ enabled, baselinePath, tolerance, floors, components }` base; shared scoping lives at this block root.',
  properties: {
    gateScoping: {
      type: 'object',
      description:
        'Shared scope applied to every gate that supports one, unless the gate overrides it.',
      properties: {
        scope: {
          type: 'string',
          enum: ['diff', 'full'],
          description:
            'Score only the files changed against `diffRef` (`diff`) or every file in the gate target dirs (`full`).',
          default: 'diff',
        },
        diffRef: {
          type: 'string',
          minLength: 1,
          description: 'Git ref the `diff` scope is computed against.',
          default: 'main',
        },
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
    requireBaselines: {
      type: 'boolean',
      description:
        'Story #4495. Fail-closed baseline-enforcement policy for the unified check-baselines close-validation gate. When false (default), a consumer that enables baseline gates (crap/maintainability/…) but has not committed the corresponding baseline artifacts under baselines/ gets a clean skip-with-reason instead of a deterministic first-try close failure. Set true to keep the gate registered so an absent baseline artifact fails close-validation with a preflight hint naming the fix (the fail-closed posture).',
      default: false,
    },
    // Navigability lens + post-wave integration gate config (Epic #4131,
    // F2/F3/F1/F4). Read by audit-suite/selector.js (route globs) and the
    // deliver-epic.md Phase 6.5 gate (journey suite). Opt-in: absent or empty
    // routeGlobs degrades to a silent no-op.
    navigability: {
      type: 'object',
      description:
        "Navigability lens + journey-suite config (Epic #4131, F2/F3/F1/F4). Read by audit-suite/selector.js (route globs) and /mandrel-deliver's per-Story ceremony (journey suite). Opt-in: absent or empty routeGlobs degrades to a silent no-op.",
      properties: {
        routeGlobs: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Glob patterns (pages/**, app/**/route.ts) marking paths that add a user-facing route — the route-tree SSOT the navigability lens enumerates and the route-added routing predicate matches against.',
          default: [],
        },
        navRegistry: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Tokens identifying the nav-registry SSOT the navigability lens checks every route resolves a nav door against.',
          default: [],
        },
        journeySuite: {
          type: 'string',
          description:
            "Path or command for the per-persona journey suite /mandrel-deliver's per-Story ceremony runs.",
        },
      },
      additionalProperties: false,
    },
  },
  additionalProperties: false,
};

/**
 * `delivery.codeReview` — review-provider chain + bounded-retry knobs for
 * the /mandrel-deliver code-review ceremony (Story-close and plan-run close).
 *
 * `autoFixSeverity` (Story #4399) is the threshold that governs which
 * findings the host-LLM focused-fix routing remediates on-branch —
 * `medium` (default) routes 🔴/🟠/🟡 while 🟢 still graduates, `high`
 * reproduces the pre-4399 Critical/High-only routing.
 */
export const CODE_REVIEW_SCHEMA = {
  type: 'object',
  description:
    'Review-provider chain plus bounded-retry knobs for the /mandrel-deliver code-review ceremony.',
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
            description:
              'Registered provider key. Inline: native, codex, security-review. Manual-prompt: ultrareview.',
          },
          scopes: {
            type: 'array',
            items: { type: 'string', enum: ['story', 'epic'] },
            description:
              'Invocation scopes this entry fires on. Default (omitted) is both.',
          },
          optional: {
            type: 'boolean',
            default: false,
            description:
              'When true, construction failure (host missing CLI/plugin) is logged and the entry is skipped instead of hard-failing the chain. Use for cross-runtime portability.',
          },
          manualPrompt: {
            type: 'boolean',
            default: false,
            description:
              'When true, the entry is loaded from the manual-prompt registry: contributes a one-line operator suggestion via `renderPrompt()` instead of running a review via `runReview()`. Does not affect severity counts or `halted`.',
          },
          when: {
            type: 'object',
            description:
              "Optional label-gated invocation predicate. Evaluated against the ticket's current labels at invocation time; when false, the entry is silently skipped for this run.",
            properties: {
              label: {
                type: 'string',
                minLength: 1,
                description: 'Single label that MUST be present on the ticket.',
              },
              labelAny: {
                type: 'array',
                items: { type: 'string', minLength: 1 },
                minItems: 1,
                description: 'Run when ANY of the listed labels is present.',
              },
            },
            additionalProperties: false,
          },
        },
        additionalProperties: false,
      },
      description:
        'Review-provider chain (Story #2871). When unset or empty, defaults to [{ name: "native" }]. The orchestrator iterates inline entries in declaration order and merges their Finding[] before posting one structured comment; manual-prompt entries (e.g. ultrareview) contribute a trailing \'Manual review suggestions\' section. Selecting an adapter whose probe fails hard-fails at factory construction unless declared `optional: true` in the chain.',
      default: [
        { name: 'native' },
        { name: 'security-review', scopes: ['story'], optional: true },
        {
          name: 'ultrareview',
          scopes: ['story'],
          manualPrompt: true,
          when: { label: 'risk::high' },
        },
      ],
    },
    providerConfig: {
      type: 'object',
      additionalProperties: true,
      description:
        'Optional escape hatch for adapter-specific configuration. No documented keys in Epic #2815; reserved so future adapters can be configured without another schema migration.',
    },
    maxFixAttempts: {
      type: 'integer',
      minimum: 0,
      description:
        'Maximum auto-fix retry attempts per finding in /mandrel-deliver Phase 5 (code-review). 0 disables auto-fix. Default 3.',
      default: DEFAULT_CODE_REVIEW.maxFixAttempts,
    },
    autoFixSeverity: {
      type: 'string',
      enum: ['high', 'medium'],
      description:
        'Severity threshold for on-branch remediation in /mandrel-deliver Phase 5 (code-review). `medium` (default) routes 🔴/🟠/🟡 findings into the host-LLM focused-fix routing (Mediums batched per lens: one commit per lens, a single validation + rescan at the end) while 🟢 suggestions still graduate to follow-up issues; `high` reproduces the pre-4399 Critical/High-only routing. Hard cutover — no back-compat flag.',
      default: DEFAULT_CODE_REVIEW.autoFixSeverity,
    },
  },
  additionalProperties: false,
};
