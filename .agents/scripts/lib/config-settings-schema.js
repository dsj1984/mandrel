/* node:coverage ignore file -- AJV schema declaration (data-as-code); MI < 70 is inherent to large flat schema literals, no business logic to test */

import { createRequire } from 'node:module';
import process from 'node:process';
import { COMMANDS_DEFAULTS } from './config/commands.js';
import {
  BRANCH_PROTECTION_DEFAULTS,
  DEFAULT_REQUIRED_CHECKS,
  MERGE_METHODS_DEFAULTS,
  NOTIFICATIONS_DEFAULTS,
} from './config/github.js';
import { PATHS_DEFAULTS } from './config/paths.js';
import { SHELL_INJECTION_PATTERN_STRING } from './config-schema-shared.js';
// `delivery.*` sub-schemas were extracted to a sibling module (refs #3457)
// to keep this aggregate module above the maintainability floor. The
// resolved AGENTRC_SCHEMA is unchanged.
import { DELIVERY_SCHEMA } from './config-settings-schema-delivery.js';
import compiledAgentrcValidator from './generated/agentrc-validator.js';
import { DEFAULT_FRAMEWORK_REPO } from './github/framework-repo.js';
import { SKILL_ID_RE } from './skills/walk-skill-files.js';

/**
 * Annotation contract (Story #5007). These schema literals are the SINGLE
 * annotated source for the whole `.agentrc.json` surface:
 *
 *   - `description` — the operator-facing gloss. `generate-config-docs.js`
 *     serializes it into the shipped JSON-Schema mirror
 *     (`.agents/schemas/agentrc.schema.json`, which every consumer config
 *     points `$schema` at) and into the `configuration.md` key table.
 *   - `default`     — the value that appears in the generated defaults
 *     inventory `.agents/docs/agentrc-reference.json` (the SSOT
 *     `lib/config/defaults.js` reads for `mandrel explain` and the
 *     sync-agentrc redundancy advisory). Import the matching runtime
 *     `*_DEFAULTS` constant rather than restating a literal wherever one
 *     exists, so the annotation and the resolver cannot drift.
 *
 * A key with a runtime default but no `default` annotation is deliberately
 * out of the inventory — annotating it would change what `mandrel explain`
 * reports and what sync-agentrc flags redundant, which is a behaviour
 * change, not a representation one.
 *
 * Nothing here is hand-mirrored any more: run `npm run docs:gen` after
 * editing, and `npm run docs:check` fails closed on drift.
 */

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
  description:
    'The three required filesystem roots. Every `${dir}Root` the framework needs is derived at runtime as `${agentRoot}/<dir>`, and the audit output dir as `${tempRoot}/audits`.',
  required: ['agentRoot', 'docsRoot', 'tempRoot'],
  properties: {
    agentRoot: {
      ...SAFE_STRING,
      minLength: 1,
      description:
        'Repo-relative root of the materialized framework tree (`mandrel sync` writes here).',
      default: PATHS_DEFAULTS.agentRoot,
    },
    docsRoot: {
      ...SAFE_STRING,
      minLength: 1,
      description:
        'Repo-relative root of the project documentation the planner reads for context.',
      default: PATHS_DEFAULTS.docsRoot,
    },
    tempRoot: {
      ...SAFE_STRING,
      minLength: 1,
      description:
        'Repo-relative gitignored scratch root. Every temporary artifact — gate transcripts, audit reports, plan authoring dirs — lands under it.',
      default: PATHS_DEFAULTS.tempRoot,
    },
  },
  additionalProperties: false,
};

/**
 * `project.commands` — names of the test/typecheck/lint/format commands the
 * close-validation chain spawns. `typecheck` accepts `null` to mean
 * "disabled"; `lint` accepts `null` to mean "use the framework default",
 * because that gate is mandatory and cannot be switched off. `validate` and `build` were dropped (no production consumers).
 */
const COMMANDS_SCHEMA = {
  type: 'object',
  description:
    'Shell commands the close-validation chain spawns. Each is run from the repo root.',
  properties: {
    test: {
      ...SAFE_STRING,
      minLength: 1,
      description: 'Full test-suite command run by the close-validation chain.',
      default: COMMANDS_DEFAULTS.test,
    },
    typecheck: {
      ...NULLABLE_NONEMPTY_SAFE_STRING,
      description:
        'Static type-check command. `null` disables the gate for projects with no type layer; the empty string is rejected so a typo cannot silently disable it.',
      default: COMMANDS_DEFAULTS.typecheck,
    },
    lint: {
      ...NULLABLE_NONEMPTY_SAFE_STRING,
      description:
        'Lint command run as a close-validation gate. `null` (the default) uses `npm run lint`; the gate is mandatory, so unlike `typecheck` this key cannot disable it. Point it at the scoped command your hooks already run to stop paying for a third whole-repo lint at close — the gate still lints the diff, and CI still owns whole-repo drift. Like every command here it must be a single argv (no `;`, `&&`, pipes or substitution), so wrap a multi-linter pair in one npm script and name that.',
      default: COMMANDS_DEFAULTS.lint,
    },
    formatCheck: {
      ...SAFE_STRING,
      minLength: 1,
      description:
        'Non-mutating format verification run as a close-validation gate.',
      default: COMMANDS_DEFAULTS.formatCheck,
    },
    formatWrite: {
      ...SAFE_STRING,
      minLength: 1,
      description:
        'Mutating format command the close-time format-autofix step spawns.',
      default: COMMANDS_DEFAULTS.formatWrite,
    },
  },
  additionalProperties: false,
};

const PROJECT_SCHEMA = {
  type: 'object',
  description:
    'Project identity, filesystem roots, planner docs context, and the commands the close-validation chain spawns.',
  required: ['paths'],
  properties: {
    baseBranch: {
      ...SAFE_STRING,
      description:
        'Branch every `story-<id>` branch is seeded from and every Story PR targets.',
      default: 'main',
    },
    paths: PATHS_SCHEMA,
    docsContextFiles: {
      type: 'array',
      items: { type: 'string' },
      description:
        'Files under `paths.docsRoot` the planner treats as standing context. Read digest-first — the docs digest names the file and the line range, and only the named section is pulled.',
      default: [
        'architecture.md',
        'data-dictionary.md',
        'decisions.md',
        'patterns.md',
      ],
    },
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
 * v2 runtime actually emits through `notify()` (Story transitions and merge
 * outcomes).
 *
 * `loop.tick` was retired here on the same rule (Story #5024). Its only
 * producer was `emit-loop-tick.js`, which published to the lifecycle bus and
 * never called `notify()` at all — and the bus had no production caller, so
 * the event could not reach a webhook by any path. The notify CLI cannot
 * substitute: it hardcodes `event: 'operator-message'` and exposes no
 * `--event` flag, so a consumer could not dispatch it either. It shipped in
 * `NOTIFICATIONS_DEFAULTS`, which meant every consumer was subscribed by
 * default to something that could never fire.
 *
 * `story.heartbeat` was retired here first (A22): the vocabulary's contract is
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
]);

/**
 * Curated GitHub-comment event vocabulary. The comment channel is gated by
 * an explicit allowlist of event names — same model as `webhookEvents`.
 *
 * **Deliberately narrower than {@link WEBHOOK_EVENT_NAMES}**, and the axis
 * is ticket scope, not importance. A comment is written *onto a Story
 * issue*, so only events that are about one Story, and whose message reads
 * as narrative an operator wants durably on the ticket, belong here. The
 * webhook-only remainder — `merge.unlanded` and `merge.flip-failed` — are
 * run-scoped beats; mirroring them onto the ticket would bury the narrative
 * under machine chatter, and `notify()` drops a comment for any dispatch
 * without a resolvable ticket id regardless.
 *
 * Note both webhook-only names are allowlistable but have no `notify()`
 * dispatcher today — they reach the run ledger via `appendLedgerEvent`, not
 * the notify path. That is a wiring gap, deliberately left alone by Story
 * #5024 (which only removed `loop.tick`, whose producer went with the bus):
 * unlike `loop.tick` these two have a live producer, so whether to wire the
 * dispatch or drop the allowlist entries is an open decision, not dead code.
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
  description:
    "Allowlist-gated notification channels. An event fires on a channel only when it is named in that channel's array.",
  properties: {
    mentionOperator: {
      type: 'boolean',
      description:
        'When true, `github.operatorHandle` is @-mentioned in the comments the notifier posts.',
      default: NOTIFICATIONS_DEFAULTS.mentionOperator,
    },
    commentEvents: {
      type: 'array',
      items: { type: 'string', enum: [...COMMENT_EVENT_NAMES] },
      uniqueItems: true,
      description:
        'Events mirrored onto the Story issue as a comment. Deliberately narrower than `webhookEvents`: only Story-scoped events whose message reads as narrative an operator wants durably on the ticket belong here.',
      default: [...NOTIFICATIONS_DEFAULTS.commentEvents],
    },
    webhookEvents: {
      type: 'array',
      items: { type: 'string', enum: [...WEBHOOK_EVENT_NAMES] },
      uniqueItems: true,
      description:
        'Events dispatched to the configured webhook. The vocabulary is the allowlist the webhook channel gates on; `merge.unlanded` and `merge.flip-failed` are allowlistable but reach the run ledger rather than `notify()` today.',
      default: [...NOTIFICATIONS_DEFAULTS.webhookEvents],
    },
  },
  additionalProperties: false,
};

const BRANCH_PROTECTION_CHECK_SCHEMA = {
  type: 'object',
  description:
    'One required status check: the context name GitHub gates the merge on, plus the argv the framework runs locally to reproduce it.',
  required: ['name', 'cmd'],
  properties: {
    name: {
      type: 'string',
      minLength: 1,
      description: 'Required status-check context name as GitHub reports it.',
    },
    cmd: {
      type: 'array',
      minItems: 1,
      items: { type: 'string', minLength: 1 },
      description:
        'argv array (never a shell string) the local pre-push validation runs to reproduce the check.',
    },
  },
  additionalProperties: false,
};

const BRANCH_PROTECTION_SCHEMA = {
  type: 'object',
  description:
    'Branch-protection stance applied to `project.baseBranch` by the GitHub bootstrap, and reproduced locally before every push.',
  properties: {
    enforce: {
      type: 'boolean',
      description:
        'When true, the GitHub bootstrap writes the required-check ruleset. False leaves the remote stance alone.',
      default: BRANCH_PROTECTION_DEFAULTS.enforce,
    },
    requiredChecks: {
      type: 'array',
      items: BRANCH_PROTECTION_CHECK_SCHEMA,
      description:
        'Checks that must pass before a Story PR merges. Each entry carries both the remote context name and the local argv.',
      default: DEFAULT_REQUIRED_CHECKS.map((c) => ({
        name: c.name,
        cmd: [...c.cmd],
      })),
    },
  },
  additionalProperties: false,
};

const MERGE_METHODS_SCHEMA = {
  type: 'object',
  description:
    'Repository merge-method stance the GitHub bootstrap enforces. The framework ships squash-only with auto-merge on, which is what the one-PR-per-Story model needs for release-please to parse each landed subject.',
  properties: {
    allow_squash_merge: {
      type: 'boolean',
      default: MERGE_METHODS_DEFAULTS.allow_squash_merge,
    },
    allow_rebase_merge: {
      type: 'boolean',
      default: MERGE_METHODS_DEFAULTS.allow_rebase_merge,
    },
    allow_merge_commit: {
      type: 'boolean',
      default: MERGE_METHODS_DEFAULTS.allow_merge_commit,
    },
    allow_auto_merge: {
      type: 'boolean',
      default: MERGE_METHODS_DEFAULTS.allow_auto_merge,
    },
    delete_branch_on_merge: {
      type: 'boolean',
      default: MERGE_METHODS_DEFAULTS.delete_branch_on_merge,
    },
  },
  additionalProperties: false,
};

/**
 * Where follow-up work is filed when the repository that surfaced it does not
 * own it. Ownership splits three ways — consumer / framework / platform — and
 * `github.owner`/`github.repo` already carry the consumer bucket, so only the
 * other two are configured here. Routing itself lives in
 * `lib/github/framework-repo.js`; an unset bucket is reported as unroutable
 * rather than silently re-pointed at the consumer's own tracker.
 */
const FOLLOW_UP_REPOS_SCHEMA = {
  type: 'object',
  description:
    'Repository slugs for the non-consumer follow-up ownership buckets, used when a CI gap, retro proposal, or audit finding belongs to someone other than the repo that surfaced it.',
  properties: {
    framework: {
      type: 'string',
      pattern: '^[^/\\s]+/[^/\\s]+$',
      description:
        '`<owner>/<repo>` that owns framework-level defects. Defaults to the Mandrel mirror — the one bucket with a knowable default.',
      default: DEFAULT_FRAMEWORK_REPO,
    },
    platform: {
      type: ['string', 'null'],
      pattern: '^[^/\\s]+/[^/\\s]+$',
      description:
        '`<owner>/<repo>` for a shared platform or infrastructure tracker (a shared base config, a runner fleet, a cross-repo toolchain). No default — nothing can guess a shared repo. Left unset, platform-owned findings file locally and say so.',
      default: null,
    },
  },
  additionalProperties: false,
};

const GITHUB_SCHEMA = {
  type: 'object',
  description:
    'GitHub provider identity plus the remote stance the bootstrap enforces. `owner`, `repo`, and `operatorHandle` are operator identity — the shipped values are placeholders, not usable defaults.',
  required: ['owner', 'repo', 'operatorHandle'],
  properties: {
    owner: {
      type: 'string',
      minLength: 1,
      description: 'GitHub owner (user or org) that hosts the repository.',
      default: '[OWNER]',
    },
    repo: {
      type: 'string',
      minLength: 1,
      description: 'Repository name under `owner`.',
      default: '[REPO]',
    },
    projectNumber: {
      type: ['integer', 'null'],
      minimum: 1,
      description:
        'Projects V2 board number the orchestrator syncs Story status onto. `null` disables board sync.',
      default: null,
    },
    projectOwner: {
      type: ['string', 'null'],
      minLength: 1,
      description:
        'Owner of the Projects V2 board when it lives outside `owner` (an org board fed by a user repo). `null` means the board shares `owner`.',
      default: null,
    },
    operatorHandle: {
      type: 'string',
      pattern: '^@.+',
      description:
        'The human the framework escalates to, `@`-prefixed. Used for HITL @-mentions on `agent::blocked`.',
      default: '@[USERNAME]',
    },
    defaultTimeoutMs: {
      type: 'integer',
      minimum: 1000,
      description:
        'Default `timeoutMs` applied to every `gh` subprocess the provider facade spawns, so a stalled socket or long-poll cannot hang an orchestration indefinitely. A `GhExecTimeoutError` from a hit ceiling is classified `transient` and retried by `withTransientRetry`. Story #2860.',
      default: 60000,
    },
    followUpRepos: FOLLOW_UP_REPOS_SCHEMA,
    branchProtection: BRANCH_PROTECTION_SCHEMA,
    mergeMethods: MERGE_METHODS_SCHEMA,
    notifications: NOTIFICATIONS_SCHEMA,
  },
  additionalProperties: false,
};

// ---------------------------------------------------------------------------
// planning.* — inputs to /mandrel-plan
// ---------------------------------------------------------------------------

// Story #4541: `planning.context.{maxBytes, summaryMode}` was retired. The
// `applyBudget` pass it fed lost its last caller in the v2 cutover, and it
// bounded a field the envelope builders discarded before shipping the raw seed
// anyway — so the key resolved but capped nothing. The live bound on
// planner-context size is the fixed `PLAN_CONTEXT_ENVELOPE_BYTE_CEILING` in
// `lib/orchestration/plan-context.js`. Setting `planning.context` is now
// rejected as an additional property, so a resurrected key fails loudly rather
// than silently doing nothing.

// Story #4811: the `planning` block's structural-snapshot key was retired
// along with the snapshot itself. The pre-computed view it configured grounded
// nothing — its default include globs missed the standard monorepo layout, and
// its knobs only re-filtered the same matched set. Spec authoring is grounded
// by the author's own targeted repo retrieval plus the Phase 8
// `validateStoryFileAssumptions` gate, neither of which is configurable here.
// `planning` carries `additionalProperties: false`, so a resurrected key fails
// loudly; the 2.20.0 retirement migration strips it on upgrade.

// Story #5312 — the planning diet. `riskHeuristics`, `complexityGate`,
// `memoryPool.{staleAfterDays, growthDelta}`, `failOnSharedEditors`,
// `requireExplicitCrossStoryDeps`, `failOnRegistryConflicts`,
// `failOnLargeFanOut`, `largeFanOutThreshold` and `crossCuttingRegistries`
// were retired together: every one either never fired on real work, duplicated
// a judgment the authoring model already makes, or guarded a consumer that no
// longer exists. The block stays `additionalProperties: false`, so a config
// still carrying one fails loudly; the 2.57.0 retirement migration strips them
// on upgrade.

const PLANNING_SCHEMA = {
  type: 'object',
  description:
    'Inputs to `/mandrel-plan`: the memory-hygiene advisory ceiling and the opt-in navigability reachability gate.',
  properties: {
    // The `/mandrel-plan` Phase 0 memory-hygiene advisory's one surviving
    // arm (Story #5285; the age and growth arms went with Story #5312).
    memoryPool: {
      type: 'object',
      description:
        'Threshold for the memory-hygiene advisory `/mandrel-plan` surfaces at Gate #1. Advisory only: it recommends `/memory-consolidate` and never gates, reroutes, or mutates the memory pool.',
      properties: {
        indexByteCeiling: {
          type: 'integer',
          minimum: 1,
          description:
            "Recommend a consolidation pass once the pool's `MEMORY.md` index exceeds this many bytes. The harness truncates the index it loads into each session at its own byte cap, so an oversized index is a loss already happening — every entry listed after the cut is invisible — rather than a hygiene forecast. Default 24576, the harness cap itself.",
          default: 24576,
        },
      },
      additionalProperties: false,
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
          default: [],
        },
        navRegistry: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Tokens identifying the nav-registry SSOT a route-adding Story is expected to reference.',
          default: [],
        },
      },
      additionalProperties: false,
    },
  },
  additionalProperties: false,
};

// ---------------------------------------------------------------------------
// delivery.* — /mandrel-deliver + story-deliver consume. The full block of
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
 *   - `planning` — the memory-hygiene advisory ceiling, navigability gate.
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

// The per-environment sign-in seam. `{ urlTemplate }` is a dev
// impersonation route; `{ skill }` names a skill by its tier-relative id
// (e.g. `stack/qa/acme-sso`), resolved against the payload skills root and
// then the consumer-writable `.agents/local/skills/` zone (Story #5135).
//
// No default anywhere in this file may name a skill id: the framework ships
// no sign-in skill, so any id baked into an inventory value would be a
// dangling pointer a consumer copies verbatim — the exact defect #5134
// reported. The `{ skill }` arm is taught in prose (`.agents/README.md`
// § "Expose a `signInSeam`"), and `resolveQaEnvironment` fails loudly on an
// id that resolves under neither root.
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
        // The id is joined onto a skills root to reach a `SKILL.md`, so the
        // shape is validated here rather than at the path join (Story #5285).
        // `SKILL_ID_RE` is imported, never restated: one regex, two
        // enforcement points — this schema and `resolveSkillFile`.
        skill: {
          ...SAFE_STRING,
          minLength: 1,
          pattern: SKILL_ID_RE.source,
          description:
            'Tier-relative skill id, e.g. `stack/qa/acme-sso`: lowercase segments of letters, digits, `.`, `_` or `-`, at least two of them, separated by `/`. A traversal (`../..`), an absolute path, a backslash or an uppercase segment is rejected here rather than normalized.',
        },
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
  description:
    'Personas the QA-harness sign-in seam accepts. Two accepted shapes: (1) a plain array of persona names — the honest shape for a `urlTemplate` dev-impersonation seam, where the persona name is the sole input the workflow consumes; (2) the object-map form keyed by persona name, where each entry carries per-persona auth material (`credentialRef` or `signInSkill`) consulted only under a skill-based or credential-based seam.',
  // Inventory value: an illustrative map showing both per-persona shapes.
  // Inventory value: illustrative credential references, not resolvable
  // ones. It deliberately does NOT illustrate the `signInSkill` arm — a
  // skill id in a shipped default is a dangling pointer (see
  // QA_SIGN_IN_SEAM_SCHEMA above); that arm is taught in prose instead.
  default: {
    admin: { credentialRef: 'QA_ADMIN_CREDENTIAL' },
    member: { credentialRef: 'QA_MEMBER_CREDENTIAL' },
  },
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
  description:
    'Deployment targets the QA harness can run against (Epic #4326). A map keyed by environment name (e.g. `local`, `staging`), each carrying its own `baseUrl`, an optional per-environment sign-in seam, and an optional `allowWrites` gate. `signInSeam` is the union `{ urlTemplate }` (a dev impersonation route) or `{ skill }` (a skill id such as `stack/qa/acme-sso`, resolved against `.agents/skills/` then the consumer-writable `.agents/local/skills/` zone, and rejected loudly by resolveQaEnvironment when it resolves under neither); omit it entirely for a target with no sign-in seam. resolveQaEnvironment selects one environment per invocation by name or by raw-URL origin match against `baseUrl`; `allowWrites` defaults to true only for the `local` environment. Replaces the retired top-level single `signInSeam`.',
  // Inventory value: an illustrative two-environment map, not a resolvable
  // default. `staging` deliberately carries NO `signInSeam` — that is the
  // honest shape for a deployed target with no dev sign-in seam, and it
  // shows the field is optional (Story #5135).
  default: {
    local: {
      baseUrl: 'http://localhost:3000',
      signInSeam: { urlTemplate: '/dev/sign-in-as/{persona}' },
    },
    staging: {
      baseUrl: 'https://staging.example.test',
      allowWrites: false,
    },
  },
  minProperties: 1,
  additionalProperties: {
    type: 'object',
    properties: {
      baseUrl: { ...SAFE_STRING, minLength: 1 },
      signInSeam: QA_SIGN_IN_SEAM_SCHEMA,
      allowWrites: { type: 'boolean' },
    },
    // `signInSeam` is OPTIONAL (Story #5135). An environment that resolves no
    // seam is a state the QA workflows already branch on — they drive the
    // unauthenticated surface and record the gap — so requiring it made an
    // honestly seamless remote target undeclarable.
    required: ['baseUrl'],
    additionalProperties: false,
  },
};

// `gherkinLint` is the static corpus gate's contract (Story #5013). It is
// deliberately its own sub-block rather than more top-level `qa` keys: the
// gate is opt-in as a whole, so presence of the block IS the opt-in signal,
// and `check-gherkin-corpus.js` needs exactly one thing to test for. `scopes`
// is a map rather than an array because a scope's name appears verbatim in
// every finding, and a map makes naming it mandatory. Defaults for the two
// escape hatches live in `lib/config/qa.js` (GHERKIN_LINT_DEFAULTS).
const QA_GHERKIN_LINT_SCHEMA = {
  type: 'object',
  description:
    'Static Gherkin corpus gate (Story #5013). Optional; the gate runs only when this block is present, so an upgrade never reddens the lint of a consumer that never asked the framework to police its `.feature` files. Inside the opt-in it fails closed: an unresolvable `@cucumber/gherkin` parser, or a scope resolving zero step definitions, exits 1 rather than reporting a clean run.',
  // Inventory value: an illustrative single-scope map, not a resolvable
  // default. Every path here is project-specific; the entry exists so
  // `mandrel explain` can show the expected shape.
  default: {
    scopes: {
      web: {
        featureRoots: ['apps/web/tests/features'],
        stepRoots: ['apps/web/tests/steps'],
      },
    },
    exemptionTags: ['@skip'],
    stepWaivers: [],
  },
  properties: {
    scopes: {
      type: 'object',
      description:
        'Binding scopes, keyed by name. Each scope resolves its own features against its own step definitions only — pooling every step root into one matcher list is what makes a cross-app false bind possible, where a step defined solely in app B silently vouches for app A. The scope name appears verbatim in every unbound finding.',
      minProperties: 1,
      additionalProperties: {
        type: 'object',
        properties: {
          featureRoots: {
            type: 'array',
            minItems: 1,
            items: { ...SAFE_STRING, minLength: 1 },
            description:
              'Directories holding the `.feature` files of this scope, walked recursively.',
          },
          stepRoots: {
            type: 'array',
            minItems: 1,
            items: { ...SAFE_STRING, minLength: 1 },
            description:
              'Directories holding the step definitions of this scope, walked recursively. Resolving zero definitions here is a fail-closed error, not a clean run.',
          },
        },
        required: ['featureRoots', 'stepRoots'],
        additionalProperties: false,
      },
    },
    exemptionTags: {
      type: 'array',
      items: { ...SAFE_STRING, minLength: 1 },
      description:
        'Tags marking a scenario as intentionally non-binding, so must-bind skips it. Never an escape from must-compile: a parse error in the file still fails the run. Default: ["@skip"].',
      default: ['@skip'],
    },
    stepWaivers: {
      type: 'array',
      items: { type: 'string', minLength: 1 },
      description:
        'Exact step texts must-bind never reports as unbound. The step index is a source scan and therefore heuristic while the parser is exact, so a false unbound must always have an escape that does not require switching the gate off. Default: [].',
      default: [],
    },
  },
  required: ['scopes'],
  additionalProperties: false,
};

export const QA_SCHEMA = {
  type: 'object',
  description:
    'Agent-driven QA harness contract (Epic #3214; environment-keyed by Epic #4326). Optional top-level block. All filesystem-pointer fields (featureRoot, fixturesManifest, designTokens) carry safeString guards rejecting shell-injection metacharacters. environments is a map of named deployment targets (each with a baseUrl, a per-environment url-template/skill sign-in seam, and an optional allowWrites gate); personas resolve to a stored credential reference or a sign-in skill, never an inline secret.',
  properties: {
    featureRoot: {
      ...SAFE_STRING,
      minLength: 1,
      description:
        'Directory holding the Gherkin feature files the QA sweep drives.',
      default: 'tests/features',
    },
    fixturesManifest: {
      ...SAFE_STRING,
      minLength: 1,
      description:
        'Path to the persona/fixture manifest the harness seeds from.',
      default: 'tests/fixtures/personas.json',
    },
    environments: QA_ENVIRONMENTS_SCHEMA,
    personas: QA_PERSONAS_SCHEMA,
    gherkinLint: QA_GHERKIN_LINT_SCHEMA,
    consoleAllowlist: {
      type: 'array',
      items: { ...SAFE_STRING, minLength: 1 },
      description:
        'Console-message substrings the QA run tolerates instead of reporting as a finding (framework dev-mode chatter).',
      default: ['Download the React DevTools', '[HMR]'],
    },
    designTokens: {
      ...SAFE_STRING,
      minLength: 1,
      description:
        'Path to the design-token SSOT the UX/UI lens checks rendered styles against.',
      default: 'src/styles/tokens.css',
    },
  },
  additionalProperties: false,
};

export const AGENTRC_SCHEMA = {
  type: 'object',
  required: ['project'],
  properties: {
    $schema: {
      type: 'string',
      description:
        'Editor pointer at the shipped JSON-Schema mirror. Not read by the runtime.',
    },
    project: PROJECT_SCHEMA,
    github: GITHUB_SCHEMA,
    planning: PLANNING_SCHEMA,
    delivery: DELIVERY_SCHEMA,
    qa: QA_SCHEMA,
  },
  additionalProperties: false,
};

let _agentrcValidator = null;

/**
 * Compile `AGENTRC_SCHEMA` with a live AJV instance.
 *
 * `ajv` is pulled in through `createRequire` rather than a top-level
 * `import` so the module never enters the graph on the fast path
 * (Story #5109). Loading AJV was itself a measurable share of the ~35 ms
 * this function used to cost in each of the 36 config-touching entry
 * scripts, and the precompiled validator needs none of it.
 *
 * @returns {import('ajv').ValidateFunction}
 */
function compileAgentrcValidatorDynamically() {
  const require = createRequire(import.meta.url);
  const ajvModule = require('ajv');
  const Ajv = ajvModule.default ?? ajvModule;
  const ajv = new Ajv({ allErrors: true });
  return ajv.compile(AGENTRC_SCHEMA);
}

/**
 * The `.agentrc.json` validator.
 *
 * Returns the **precompiled** validator committed at
 * `lib/generated/agentrc-validator.js` — AJV's standalone emit for the exact
 * `AGENTRC_SCHEMA` literal above, kept in step by
 * `check-generated-validator.js --check` inside `npm run lint`. The verdicts
 * are AJV's own, produced by AJV's own generated code with the same
 * `allErrors: true` option the dynamic path uses, so nothing about what a
 * config is allowed to contain changes — only when the codegen runs.
 *
 * Set `MANDREL_AGENTRC_VALIDATOR=dynamic` to compile at runtime instead. That
 * escape hatch exists so a consumer who has hand-edited the schema (or hit a
 * platform where the generated module will not load) is never stuck with a
 * validator they cannot regenerate; it costs the ~35 ms the artifact removes.
 *
 * @returns {import('ajv').ValidateFunction}
 */
export function getAgentrcValidator() {
  if (_agentrcValidator) return _agentrcValidator;
  _agentrcValidator =
    process.env.MANDREL_AGENTRC_VALIDATOR === 'dynamic'
      ? compileAgentrcValidatorDynamically()
      : compiledAgentrcValidator;
  return _agentrcValidator;
}
