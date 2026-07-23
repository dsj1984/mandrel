/* node:coverage ignore file -- AJV schema declaration (data-as-code); MI < 70 is inherent to large flat schema literals, no business logic to test */

import Ajv from 'ajv';

import { SHELL_INJECTION_PATTERN_STRING } from './config-schema-shared.js';
// `delivery.*` sub-schemas were extracted to a sibling module (refs #3457)
// to keep this aggregate module above the maintainability floor. The
// resolved AGENTRC_SCHEMA is unchanged.
import { DELIVERY_SCHEMA } from './config-settings-schema-delivery.js';

const SAFE_STRING = {
  type: 'string',
  not: { pattern: SHELL_INJECTION_PATTERN_STRING },
};

const _NULLABLE_SAFE_STRING = {
  type: ['string', 'null'],
  not: { type: 'string', pattern: SHELL_INJECTION_PATTERN_STRING },
};

/**
 * Optional commands that may be `null` to mean "disabled" but, when set as a
 * string, must be non-empty. `minLength` is a string-only keyword so it is a
 * no-op for `null`; the empty string is explicitly rejected.
 */
const NULLABLE_NONEMPTY_SAFE_STRING = {
  type: ['string', 'null'],
  minLength: 1,
  not: { type: 'string', pattern: SHELL_INJECTION_PATTERN_STRING },
};

/** A list-valued config key may be a plain array (replace) or an extender
 * object `{ append, prepend }` that deep-merges with framework defaults. */
const LIST_OR_EXTENDER_OF_STRINGS = {
  oneOf: [
    { type: 'array', items: { type: 'string' } },
    {
      type: 'object',
      properties: {
        append: { type: 'array', items: { type: 'string' } },
        prepend: { type: 'array', items: { type: 'string' } },
      },
      additionalProperties: false,
    },
  ],
};

/**
 * Backwards-compatible export used by a handful of call sites that historically
 * scanned the schema for string-shaped fields. Post-reshape, the only
 * top-level flat string field of the legacy agentSettings bag is gone; the
 * export is kept (empty) so old imports don't fail.
 */
export const AGENT_SETTINGS_STRING_FIELDS = Object.freeze([]);

// ---------------------------------------------------------------------------
// project.* — identity, conventions, commands
// ---------------------------------------------------------------------------

/**
 * `project.paths` carries the three required filesystem roots. The seven
 * legacy `*Root` subdirectory keys and the legacy `auditOutputDir` were
 * dropped — every `${dir}Root` is derived at runtime as `${agentRoot}/<dir>`
 * and `auditOutputDir` is derived as `${tempRoot}/audits`.
 */
const PATHS_SCHEMA = {
  type: 'object',
  required: ['agentRoot', 'docsRoot', 'tempRoot'],
  properties: {
    agentRoot: { ...SAFE_STRING, minLength: 1 },
    docsRoot: { ...SAFE_STRING, minLength: 1 },
    tempRoot: { ...SAFE_STRING, minLength: 1 },
  },
  additionalProperties: false,
};

/**
 * `project.commands` — names of the lint/test/typecheck/format commands the
 * close-validation chain spawns. `typecheck` accepts `null` to mean
 * "disabled". `validate` and `build` were dropped (no production consumers).
 */
const COMMANDS_SCHEMA = {
  type: 'object',
  properties: {
    lintBaseline: { ...SAFE_STRING, minLength: 1 },
    test: { ...SAFE_STRING, minLength: 1 },
    typecheck: NULLABLE_NONEMPTY_SAFE_STRING,
    formatCheck: { ...SAFE_STRING, minLength: 1 },
    formatWrite: { ...SAFE_STRING, minLength: 1 },
  },
  additionalProperties: false,
};

const PROJECT_SCHEMA = {
  type: 'object',
  required: ['paths'],
  properties: {
    baseBranch: SAFE_STRING,
    paths: PATHS_SCHEMA,
    docsContextFiles: { type: 'array', items: { type: 'string' } },
    commands: COMMANDS_SCHEMA,
  },
  additionalProperties: false,
};

// ---------------------------------------------------------------------------
// github.* — provider identity, bootstrap, notifications
// ---------------------------------------------------------------------------

/**
 * Curated webhook event vocabulary. The webhook channel is gated by an
 * explicit allowlist of event names — the vocabulary mirrors the events the
 * v2 runtime actually emits through `notify()` (Story transitions, merge
 * outcomes, loop lifecycle beats).
 *
 * `story.heartbeat` was retired here (A22): the vocabulary's contract is
 * "events the runtime actually emits", and nothing could emit this one. Its
 * emitter (`emit-story-heartbeat.js`) demanded an `epicId >= 1` while the
 * sole call path (`single-story-init.js` → `setActiveStoryEnv`) passed
 * `epicId: null`, so `CC_EPIC_ID` was never set and the hook that would have
 * fired the beat always short-circuited. Emitter, hook, and schema are all
 * deleted; keeping the name allowlistable would let an operator subscribe to
 * a channel that can never deliver. Removing it from the enum makes a
 * resurrection fail loudly at config-validation time rather than silently
 * never firing.
 */
export const WEBHOOK_EVENT_NAMES = Object.freeze([
  'state-transition',
  'story-merged',
  'story-closing',
  'operator-message',
  'merge.unlanded',
  'merge.flip-failed',
  'loop.tick',
]);

/**
 * Curated GitHub-comment event vocabulary. The comment channel is gated by
 * an explicit allowlist of event names — same model as `webhookEvents`.
 *
 * **Deliberately narrower than {@link WEBHOOK_EVENT_NAMES}**, and the axis
 * is ticket scope, not importance. A comment is written *onto a Story
 * issue*, so only events that are about one Story, and whose message reads
 * as narrative an operator wants durably on the ticket, belong here. The
 * webhook-only remainder — `merge.unlanded`, `merge.flip-failed`,
 * `loop.tick` — are run-scoped or firehose beats;
 * mirroring them onto the ticket would bury the narrative under machine
 * chatter, and `notify()` drops a comment for any dispatch without a
 * resolvable ticket id regardless.
 *
 * `story-closing` IS in scope by that rule (Story-scoped, `level: 'story'`,
 * human-readable — the same shape as `story-merged`) and its earlier
 * absence was an oversight: the event was emittable to webhooks but could
 * not be allowlisted for comments at all. It is in the vocabulary but NOT
 * in the shipped default (`config/github.js` `NOTIFICATIONS_DEFAULTS`) —
 * opting in is an operator choice, not a behaviour change forced on every
 * consumer.
 */
export const COMMENT_EVENT_NAMES = Object.freeze([
  'state-transition',
  'story-merged',
  'story-closing',
  'operator-message',
]);

const NOTIFICATIONS_SCHEMA = {
  type: 'object',
  properties: {
    mentionOperator: { type: 'boolean' },
    commentEvents: {
      type: 'array',
      items: { type: 'string', enum: [...COMMENT_EVENT_NAMES] },
      uniqueItems: true,
    },
    webhookEvents: {
      type: 'array',
      items: { type: 'string', enum: [...WEBHOOK_EVENT_NAMES] },
      uniqueItems: true,
    },
  },
  additionalProperties: false,
};

const BRANCH_PROTECTION_CHECK_SCHEMA = {
  type: 'object',
  required: ['name', 'cmd'],
  properties: {
    name: { type: 'string', minLength: 1 },
    cmd: {
      type: 'array',
      minItems: 1,
      items: { type: 'string', minLength: 1 },
    },
  },
  additionalProperties: false,
};

const BRANCH_PROTECTION_SCHEMA = {
  type: 'object',
  properties: {
    enforce: { type: 'boolean' },
    requiredChecks: {
      type: 'array',
      items: BRANCH_PROTECTION_CHECK_SCHEMA,
    },
  },
  additionalProperties: false,
};

const MERGE_METHODS_SCHEMA = {
  type: 'object',
  properties: {
    allow_squash_merge: { type: 'boolean' },
    allow_rebase_merge: { type: 'boolean' },
    allow_merge_commit: { type: 'boolean' },
    allow_auto_merge: { type: 'boolean' },
    delete_branch_on_merge: { type: 'boolean' },
  },
  additionalProperties: false,
};

const GITHUB_SCHEMA = {
  type: 'object',
  required: ['owner', 'repo', 'operatorHandle'],
  properties: {
    owner: { type: 'string', minLength: 1 },
    repo: { type: 'string', minLength: 1 },
    projectNumber: { type: ['integer', 'null'], minimum: 1 },
    projectOwner: { type: ['string', 'null'], minLength: 1 },
    operatorHandle: { type: 'string', pattern: '^@.+' },
    defaultTimeoutMs: { type: 'integer', minimum: 1000 },
    branchProtection: BRANCH_PROTECTION_SCHEMA,
    mergeMethods: MERGE_METHODS_SCHEMA,
    notifications: NOTIFICATIONS_SCHEMA,
  },
  additionalProperties: false,
};

// ---------------------------------------------------------------------------
// planning.* — inputs to /plan
// ---------------------------------------------------------------------------

// Story #4541: `planning.context.{maxBytes, summaryMode}` was retired. The
// `applyBudget` pass it fed lost its last caller in the v2 cutover, and it
// bounded a field the envelope builders discarded before shipping the raw seed
// anyway — so the key resolved but capped nothing. The live bound on
// planner-context size is the fixed `PLAN_CONTEXT_ENVELOPE_BYTE_CEILING` in
// `lib/orchestration/plan-context.js`. Setting `planning.context` is now
// rejected as an additional property, so a resurrected key fails loudly rather
// than silently doing nothing.

/**
 * Story #2634 — `planning.codebaseSnapshot` controls the structural
 * view of the consumer repo threaded into `/plan` Phase 7 spec
 * authoring. Absent / partial entries resolve to defaults inside
 * `lib/codebase-snapshot.js#resolveSnapshotConfig` — the schema only
 * enforces shape (correct enum value, well-formed glob arrays).
 */
const CODEBASE_SNAPSHOT_SCHEMA = {
  type: 'object',
  properties: {
    tier: { type: 'string', enum: ['skinny', 'medium'] },
    include: {
      type: 'array',
      items: { type: 'string', minLength: 1 },
    },
    exclude: {
      type: 'array',
      items: { type: 'string', minLength: 1 },
    },
    recentCommitWindow: { type: 'integer', minimum: 1 },
  },
  additionalProperties: false,
};

const PLANNING_SCHEMA = {
  type: 'object',
  properties: {
    riskHeuristics: LIST_OR_EXTENDER_OF_STRINGS,
    codebaseSnapshot: CODEBASE_SNAPSHOT_SCHEMA,
    // Story #4683 — plan-time ceremony-lite complexity gate. Routes a trivial
    // single-artifact seed onto a collapsed plan/deliver path while a
    // multi-capability seed keeps the full ceremony. Deterministic and
    // conservative (full on any doubt); the lite path never relaxes a
    // non-negotiable (Story ticket, PR-to-main, repo gates, security baseline).
    // Defaults live on DEFAULT_COMPLEXITY_GATE in
    // `lib/orchestration/complexity-gate.js`.
    complexityGate: {
      type: 'object',
      description:
        'Plan-time ceremony-lite complexity gate. Routes trivial single-artifact seeds onto a collapsed plan/deliver path; conservative (full on any doubt). Never relaxes the Story-ticket / PR-to-main / repo-gates / security-baseline non-negotiables.',
      properties: {
        enabled: {
          type: 'boolean',
          description:
            'Master switch. When false, every seed takes the full plan/deliver ceremony. Default true.',
        },
        maxSeedWords: {
          type: 'integer',
          minimum: 0,
          description:
            'Seed prose word ceiling for the lite path. A seed above this many words is not trivial and takes the full path. Default 150.',
        },
        maxArtifacts: {
          type: 'integer',
          minimum: 0,
          description:
            'Enumerated-artifact ceiling for the lite path. A seed enumerating more than this many candidate artifacts is multi-capability and takes the full path. Default 1.',
        },
      },
      additionalProperties: false,
    },
    // Cross-Story conflict-finding severity gates. Off by default so
    // existing repos keep advisory-only behaviour; flipping either to
    // `true` upgrades the matching finding class to `'hard'`, which routes
    // it through the validator's `errors[]` channel and trips the bounded
    // decompose loop's re-prompt gate.
    // `planning.modelCapacity` was collapsed to the framework constant
    // `DEFAULT_MODEL_CAPACITY` in ticket-validator-sizing.js (authored-
    // tokens-only mass); setting it in a config is rejected as an
    // additional property.
    failOnSharedEditors: {
      type: 'boolean',
      description:
        'When true, upgrade shared-editor conflict findings to hard errors (default false — advisory soft findings only).',
    },
    requireExplicitCrossStoryDeps: {
      type: 'boolean',
      description:
        'When true, upgrade implicit cross-Story dependency findings to hard errors (default false — advisory soft findings only).',
    },
    // Cross-cutting registry conflict knobs consumed by
    // `ticket-validator-conflicts.js` (wired through
    // `epic-plan-decompose/phases/planning-artifacts.js`).
    // `crossCuttingRegistries` names the registry paths whose concurrent
    // edits are flagged; `failOnRegistryConflicts` upgrades that finding to
    // `'hard'`. `failOnLargeFanOut` / `largeFanOutThreshold` gate the
    // delete blast-radius finding (call sites of a module a Story marks
    // `assumption: "deletes"`).
    crossCuttingRegistries: {
      ...LIST_OR_EXTENDER_OF_STRINGS,
      description:
        'Registry path patterns whose concurrent edits across Stories are flagged as conflicts. Defaults to the framework listener/handler index patterns when omitted.',
    },
    failOnRegistryConflicts: {
      type: 'boolean',
      description:
        'When true, upgrade cross-cutting registry conflict findings to hard errors (default false).',
    },
    failOnLargeFanOut: {
      type: 'boolean',
      description:
        'When true, upgrade fan-out-warning findings (delete blast radius) to hard errors (default false — soft advisory).',
    },
    largeFanOutThreshold: {
      type: 'integer',
      minimum: 0,
      description:
        'Call-site count above which a Story that deletes a module emits a fan-out-warning. Counts base-branch references to the deleted path basename. Soft by default; does not size or reject Stories. Default 10.',
    },
    // Navigability-reachability config consumed by the plan-persist draft
    // reachability gate (Epic #4131 F7; demoted into persist by #4474 PR6).
    // Opt-in: absent or empty routeGlobs degrades to a silent no-op.
    navigation: {
      type: 'object',
      description:
        'Opt-in navigability reachability gate. Absent or empty routeGlobs is a silent no-op.',
      properties: {
        routeGlobs: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Glob patterns (e.g. pages/**, app/**/route.ts) marking paths that add a user-facing route.',
        },
        navRegistry: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Tokens identifying the nav-registry SSOT a route-adding Story is expected to reference.',
        },
      },
      additionalProperties: false,
    },
  },
  additionalProperties: false,
};

// ---------------------------------------------------------------------------
// delivery.* — /deliver + story-deliver consume. The full block of
// per-key sub-schemas lives in `config-settings-schema-delivery.js` (refs
// #3457); DELIVERY_SCHEMA is imported above and referenced unchanged below.
// ---------------------------------------------------------------------------
// Top-level: { project, github, planning, delivery }
// ---------------------------------------------------------------------------

/**
 * The top-level `.agentrc.json` shape, post-reshape (Epic #1720 Story #1739).
 *
 * The four blocks mirror SDLC phases:
 *   - `project`  — identity, paths, commands, docs context.
 *   - `github`   — provider identity, branch protection, merge methods,
 *                  notifications.
 *   - `planning` — risk heuristics, max tickets, planning-context limits.
 *   - `delivery` — execution timeouts, worktree isolation, deliver-runner
 *                  concurrency, docs-freshness, signals, quality.
 *
 * Hard cutover (Epic #2646, Story #2687; finalized by Epic #2880, Story
 * #2935): the legacy `agentSettings.*` / `orchestration.*` input shape is
 * rejected entirely by this schema (top-level `additionalProperties: false`
 * fails any document carrying those keys), the corresponding resolver-side
 * compat branches were swept across the seven `lib/config/*.js` accessors,
 * and the output-side shim on `resolveConfig` was deleted — every consumer
 * now reads the canonical `project` / `github` / `planning` / `delivery`
 * blocks directly.
 */
// ---------------------------------------------------------------------------
// qa.* — Agent-driven QA harness contract (Epic #3214)
// ---------------------------------------------------------------------------

const QA_SIGN_IN_SEAM_SCHEMA = {
  oneOf: [
    {
      type: 'object',
      properties: {
        urlTemplate: { ...SAFE_STRING, minLength: 1 },
      },
      required: ['urlTemplate'],
      additionalProperties: false,
    },
    {
      type: 'object',
      properties: {
        skill: { ...SAFE_STRING, minLength: 1 },
      },
      required: ['skill'],
      additionalProperties: false,
    },
  ],
};

// `personas` accepts two shapes (Story #3306). The plain `string[]` of
// persona names is the honest shape for a `urlTemplate` dev-impersonation
// seam, where the workflow substitutes only the persona name into the URL
// and never reads per-persona auth material. The object-map form (keyed by
// persona name, each entry carrying `credentialRef` or `signInSkill`) is
// for `skill`/credential seams where per-persona material is genuinely
// consulted. The resolver normalizes both to one canonical internal form.
const QA_PERSONAS_SCHEMA = {
  oneOf: [
    {
      type: 'array',
      minItems: 1,
      items: { ...SAFE_STRING, minLength: 1 },
    },
    {
      type: 'object',
      minProperties: 1,
      additionalProperties: {
        oneOf: [
          {
            type: 'object',
            properties: {
              credentialRef: { ...SAFE_STRING, minLength: 1 },
            },
            required: ['credentialRef'],
            additionalProperties: false,
          },
          {
            type: 'object',
            properties: {
              signInSkill: { ...SAFE_STRING, minLength: 1 },
            },
            required: ['signInSkill'],
            additionalProperties: false,
          },
        ],
      },
    },
  ],
};

// `environments` is the environment-keyed contract (Epic #4326, Story #4327).
// It replaces the retired top-level single `signInSeam` shape: each named
// environment carries its own `baseUrl`, its own per-environment `signInSeam`
// (reusing the same url-template/skill union), and an optional `allowWrites`
// gate. Downstream, `resolveQaEnvironment` selects one environment per
// invocation by name or by raw-URL origin match against `baseUrl`. The map
// must carry at least one environment. This is a hard cutover — there is no
// top-level `signInSeam` acceptance branch (see
// `.agents/rules/git-conventions.md` § Contract Cutovers).
const QA_ENVIRONMENTS_SCHEMA = {
  type: 'object',
  minProperties: 1,
  additionalProperties: {
    type: 'object',
    properties: {
      baseUrl: { ...SAFE_STRING, minLength: 1 },
      signInSeam: QA_SIGN_IN_SEAM_SCHEMA,
      allowWrites: { type: 'boolean' },
    },
    required: ['baseUrl', 'signInSeam'],
    additionalProperties: false,
  },
};

export const QA_SCHEMA = {
  type: 'object',
  properties: {
    featureRoot: { ...SAFE_STRING, minLength: 1 },
    fixturesManifest: { ...SAFE_STRING, minLength: 1 },
    environments: QA_ENVIRONMENTS_SCHEMA,
    personas: QA_PERSONAS_SCHEMA,
    consoleAllowlist: {
      type: 'array',
      items: { ...SAFE_STRING, minLength: 1 },
    },
    designTokens: { ...SAFE_STRING, minLength: 1 },
  },
  additionalProperties: false,
};

export const AGENTRC_SCHEMA = {
  type: 'object',
  required: ['project'],
  properties: {
    $schema: { type: 'string' },
    project: PROJECT_SCHEMA,
    github: GITHUB_SCHEMA,
    planning: PLANNING_SCHEMA,
    delivery: DELIVERY_SCHEMA,
    qa: QA_SCHEMA,
  },
  additionalProperties: false,
};

let _agentrcValidator = null;
export function getAgentrcValidator() {
  if (!_agentrcValidator) {
    const ajv = new Ajv({ allErrors: true });
    _agentrcValidator = ajv.compile(AGENTRC_SCHEMA);
  }
  return _agentrcValidator;
}
