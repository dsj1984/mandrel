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
  },
  additionalProperties: false,
};

export const CODE_REVIEW_SCHEMA = {
  type: 'object',
  description:
    'Review-provider chain and on-branch remediation threshold for the /mandrel-deliver code-review ceremony.',
  properties: {
    // An adapter whose probe fails (e.g. codex without the Codex CLI)
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
              'llm-review',
              'security-review',
              'ultrareview',
            ],
            description:
              'Registered provider key. Inline: native, code-review, codex, llm-review, security-review. Manual-prompt: ultrareview.',
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
        "Review-provider chain (Story #2871). When unset or empty, falls back to this default: `native` (maintainability scoring of the changed files) then an optional story-scoped `llm-review` — the first available of `code-review` (a low-effort `claude --print` bug review whose every finding is critical and halts close before auto-merge) and `codex` (`codex exec`), so a host with both CLIs runs one LLM review and a host with neither skips it. Pin `code-review` or `codex` to choose the CLI. `security-review` and `ultrareview` are opt-in. The orchestrator iterates inline entries in declaration order and merges their Finding[] before posting one structured comment; manual-prompt entries (e.g. ultrareview) contribute a trailing 'Manual review suggestions' section. Selecting an adapter whose probe fails hard-fails at factory construction unless declared `optional: true` in the chain.",
      default: DEFAULT_REVIEW_PROVIDERS,
    },
    autoFixSeverity: {
      type: 'string',
      enum: ['high', 'medium'],
      description:
        'Severity threshold for on-branch remediation in /mandrel-deliver Phase 5 (code-review). `medium` (default) routes 🔴/🟠/🟡 findings into the host-LLM focused-fix routing (Mediums batched per lens: one commit per lens, a single validation + rescan at the end) while 🟢 suggestions still graduate to follow-up issues; `high` reproduces the pre-4399 Critical/High-only routing. Hard cutover — no back-compat flag.',
      default: DEFAULT_CODE_REVIEW.autoFixSeverity,
    },
    sensitivePaths: {
      type: 'object',
      description:
        "The project's own sensitive-path classes, merged additively over the shipped `audit-rules.json` `sensitivePaths`: a class named like a shipped one appends its patterns to it, a new name adds a class, and no shipped class or pattern can be removed or narrowed. A changed file matching any class derives a `high` change level, which drives both code-review depth (`deep`, never `light`) and plan-time routing. Patterns are picomatch globs matched with `dot: true`.",
      propertyNames: { pattern: '^[a-z0-9][a-z0-9-]*$' },
      additionalProperties: {
        type: 'object',
        required: ['filePatterns'],
        properties: {
          description: { type: 'string' },
          filePatterns: {
            type: 'array',
            minItems: 1,
            items: { type: 'string', minLength: 1 },
          },
        },
        additionalProperties: false,
      },
    },
    guidanceFile: {
      type: 'string',
      minLength: 1,
      description:
        "Project review guidance, a path relative to the project root. Unset, a root `REVIEW.md` is used when present; an absent file is a no-op. Its text is rendered into every LLM review provider's prompt after the framework's severity and anti-gaming rules, and over 8,000 characters is truncated with a degradation. Guidance may add failure classes and paths worth skipping but cannot lower a severity rule, excuse a `shortcut:`, or change the output shape.",
    },
    skipPaths: {
      type: 'array',
      items: { type: 'string', minLength: 1 },
      description:
        'Picomatch globs (`dot: true`) whose findings are dropped after grounding and before severity is counted; the report states how many were dropped. A finding is dropped when its file, or every instance file, matches. Only config sets skip paths: guidance prose cannot silence a finding.',
    },
  },
  additionalProperties: false,
};
