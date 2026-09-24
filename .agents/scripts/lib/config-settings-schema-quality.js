/* node:coverage ignore file -- AJV schema declaration (data-as-code); MI < 70 is inherent to large flat schema literals, no business logic to test */

// delivery.quality.* and delivery.codeReview sub-schemas; per-gate shapes
// live in `config/gates/`.

import { GATES_SCHEMA } from './config/gates/index.js';
import { DEFAULT_REVIEW_PROVIDERS } from './config/review-chain-default.js';
import { DEFAULT_CODE_REVIEW } from './config/runners.js';

const AUTO_REFRESH_SCHEMA = {
  type: 'object',
  description:
    'Baseline-attribution auto-refresh: when a gate can prove a regression is a legitimate consequence of the diff, it rewrites the baseline instead of blocking. The single-row CRAP jump cap (5) and the rescore scope (`diff`) are fixed.',
  properties: {
    enabled: {
      type: 'boolean',
      description:
        'Master switch for the auto-refresh path. When false, every baseline refresh is a deliberate operator action.',
      default: true,
    },
  },
  additionalProperties: false,
};

export const QUALITY_SCHEMA = {
  type: 'object',
  description:
    'Quality-gate configuration. Every gate lives under `gates.<tier>` and shares the same `{ enabled, baselinePath, tolerance, floors, components }` base.',
  properties: {
    gates: GATES_SCHEMA,
    autoRefresh: AUTO_REFRESH_SCHEMA,
    requireBaselines: {
      type: 'boolean',
      description:
        'Story #4495. Fail-closed baseline-enforcement policy for the unified check-baselines close-validation gate. When false (default), a consumer that enables baseline gates (crap/maintainability/…) but has not committed the corresponding baseline artifacts under baselines/ gets a clean skip-with-reason instead of a deterministic first-try close failure. Set true to keep the gate registered so an absent baseline artifact fails close-validation with a preflight hint naming the fix (the fail-closed posture).',
      default: false,
    },
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

export const CODE_REVIEW_SCHEMA = {
  type: 'object',
  description:
    'Review-provider chain and on-branch remediation threshold for the /mandrel-deliver code-review ceremony.',
  properties: {
    // An adapter whose probe fails (e.g. codex without `/codex:review`)
    // hard-fails at construction — no silent fallback to native.
    providers: {
      type: 'array',
      items: {
        type: 'object',
        required: ['name'],
        properties: {
          name: {
            type: 'string',
            enum: [
              'native',
              'code-review',
              'codex',
              'security-review',
              'ultrareview',
            ],
            description:
              'Registered provider key. Inline: native, code-review, codex, security-review. Manual-prompt: ultrareview.',
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
        "Review-provider chain (Story #2871). When unset or empty, falls back to this default: `native` (scoped lint + MI) then an optional story-scoped `code-review` — a low-effort `claude --print` bug review whose every finding is critical and halts close before auto-merge; hosts without the `claude` CLI skip it. `security-review` and `ultrareview` are opt-in. The orchestrator iterates inline entries in declaration order and merges their Finding[] before posting one structured comment; manual-prompt entries (e.g. ultrareview) contribute a trailing 'Manual review suggestions' section. Selecting an adapter whose probe fails hard-fails at factory construction unless declared `optional: true` in the chain.",
      default: DEFAULT_REVIEW_PROVIDERS,
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
