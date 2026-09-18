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
import { DELIVERY_SCHEMA } from './config-settings-schema-delivery.js';
import compiledAgentrcValidator from './generated/agentrc-validator.js';
import { DEFAULT_FRAMEWORK_REPO } from './github/framework-repo.js';
import { SKILL_ID_RE } from './skills/walk-skill-files.js';

/**
 * The single annotated source for `.agentrc.json`: `description` feeds the
 * generated JSON-Schema mirror and configuration.md; `default` feeds the
 * defaults inventory (import the runtime `*_DEFAULTS` constant, never restate
 * a literal). A runtime default left unannotated is deliberately out of the
 * inventory. Run `npm run docs:gen` after editing.
 */

const SAFE_STRING = {
  type: 'string',
  not: { pattern: SHELL_INJECTION_PATTERN_STRING },
};

const _NULLABLE_SAFE_STRING = {
  type: ['string', 'null'],
  not: { type: 'string', pattern: SHELL_INJECTION_PATTERN_STRING },
};

/** `null` allowed; a string must be non-empty (`minLength` ignores `null`). */
const NULLABLE_NONEMPTY_SAFE_STRING = {
  type: ['string', 'null'],
  minLength: 1,
  not: { type: 'string', pattern: SHELL_INJECTION_PATTERN_STRING },
};

/** Kept empty so existing imports still resolve. */
export const AGENT_SETTINGS_STRING_FIELDS = Object.freeze([]);

// project.*

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

// github.*

/**
 * Webhook allowlist vocabulary: only events the runtime can actually emit, so
 * an operator can never subscribe to a channel that cannot deliver.
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
 * Comment allowlist vocabulary, deliberately narrower than
 * {@link WEBHOOK_EVENT_NAMES}: only Story-scoped narrative events belong on a
 * ticket. The run-scoped `merge.*` beats stay webhook-only (they reach the
 * run ledger, not `notify()`; wiring them is an open decision, not dead code).
 * `story-closing` is allowlistable but not in the shipped default.
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
 * The non-consumer follow-up buckets (`github.owner/repo` is the consumer
 * one). An unset bucket is reported unroutable, never re-pointed locally.
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
    followUpRepos: FOLLOW_UP_REPOS_SCHEMA,
    branchProtection: BRANCH_PROTECTION_SCHEMA,
    mergeMethods: MERGE_METHODS_SCHEMA,
    notifications: NOTIFICATIONS_SCHEMA,
  },
  additionalProperties: false,
};

// planning.* — `additionalProperties: false`, so a retired key fails loudly.

const PLANNING_SCHEMA = {
  type: 'object',
  description:
    'Inputs to `/mandrel-plan`: the opt-in navigability reachability gate.',
  properties: {
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

// qa.* — agent-driven QA harness contract.

// No default in this file may name a skill id: the framework ships no sign-in
// skill, so any baked-in id is a dangling pointer consumers copy verbatim.
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
        // The id is joined onto a skills root, so its shape is validated here;
        // `SKILL_ID_RE` is shared with `resolveSkillFile`, never restated.
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

// The resolver normalizes both shapes to one canonical internal form.
const QA_PERSONAS_SCHEMA = {
  description:
    'Personas the QA-harness sign-in seam accepts. Two accepted shapes: (1) a plain array of persona names — the honest shape for a `urlTemplate` dev-impersonation seam, where the persona name is the sole input the workflow consumes; (2) the object-map form keyed by persona name, where each entry carries per-persona auth material (`credentialRef` or `signInSkill`) consulted only under a skill-based or credential-based seam.',
  // Illustrative only; omits the `signInSkill` arm (no skill ids in defaults).
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

const QA_ENVIRONMENTS_SCHEMA = {
  type: 'object',
  description:
    'Deployment targets the QA harness can run against (Epic #4326). A map keyed by environment name (e.g. `local`, `staging`), each carrying its own `baseUrl`, an optional per-environment sign-in seam, and an optional `allowWrites` gate. `signInSeam` is the union `{ urlTemplate }` (a dev impersonation route) or `{ skill }` (a skill id such as `stack/qa/acme-sso`, resolved against `.agents/skills/` then the consumer-writable `.agents/local/skills/` zone, and rejected loudly by resolveQaEnvironment when it resolves under neither); omit it entirely for a target with no sign-in seam. resolveQaEnvironment selects one environment per invocation by name or by raw-URL origin match against `baseUrl`; `allowWrites` defaults to true only for the `local` environment. Replaces the retired top-level single `signInSeam`.',
  // Illustrative; `staging` omits `signInSeam` to show it is optional.
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
    // No seam is a state QA workflows handle (unauthenticated drive).
    required: ['baseUrl'],
    additionalProperties: false,
  },
};

// Presence of the block is the opt-in signal. `scopes` is a map so every
// scope is named (the name appears in each finding).
const QA_GHERKIN_LINT_SCHEMA = {
  type: 'object',
  description:
    'Static Gherkin corpus gate (Story #5013). Optional; the gate runs only when this block is present, so an upgrade never reddens the lint of a consumer that never asked the framework to police its `.feature` files. Inside the opt-in it fails closed: an unresolvable `@cucumber/gherkin` parser, or a scope resolving zero step definitions, exits 1 rather than reporting a clean run.',
  // Illustrative shape for `mandrel explain`, not a resolvable default.
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
 * `ajv` loads via `createRequire` so it stays off the fast path entirely.
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
 * Returns the precompiled AJV standalone validator (kept in step with
 * `AGENTRC_SCHEMA` by `check-generated-validator.js`).
 * `MANDREL_AGENTRC_VALIDATOR=dynamic` compiles at runtime instead, for a
 * hand-edited schema or a platform where the generated module won't load.
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
