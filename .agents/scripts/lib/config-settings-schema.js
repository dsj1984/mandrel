import Ajv from 'ajv';

import { SHELL_INJECTION_PATTERN_STRING } from './config-schema-shared.js';

/**
 * Flat agentSettings string fields. Every entry below is constrained to a
 * non-malicious string by {@link AGENT_SETTINGS_SCHEMA}. The seven `*Root`
 * filesystem keys moved under `agentSettings.paths.*` in Epic #773 Story 9
 * (atomic cutover — no flat fallback). Command fields live under
 * `agentSettings.commands` — see {@link COMMANDS_SCHEMA} below.
 */
export const AGENT_SETTINGS_STRING_FIELDS = Object.freeze(['baseBranch']);

const SAFE_STRING = {
  type: 'string',
  not: { pattern: SHELL_INJECTION_PATTERN_STRING },
};

const NULLABLE_SAFE_STRING = {
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

const MAINTAINABILITY_CRAP_SCHEMA = {
  type: 'object',
  properties: {
    enabled: { type: 'boolean' },
    targetDirs: LIST_OR_EXTENDER_OF_STRINGS,
    newMethodCeiling: { type: 'integer', minimum: 1 },
    coveragePath: { ...SAFE_STRING, minLength: 1 },
    tolerance: { type: 'number', minimum: 0 },
    requireCoverage: { type: 'boolean' },
    friction: {
      type: 'object',
      properties: { markerKey: { type: 'string', minLength: 1 } },
      additionalProperties: false,
    },
    refreshTag: { ...SAFE_STRING, minLength: 1 },
  },
  // `coveragePath` is required only when the user has explicitly opted into
  // coverage enforcement (`enabled: true` AND `requireCoverage: true`). Either
  // flag absent/false leaves the path optional so disabled crap blocks and
  // coverage-relaxed configs both validate without ceremony.
  allOf: [
    {
      if: {
        properties: {
          enabled: { const: true },
          requireCoverage: { const: true },
        },
        required: ['enabled', 'requireCoverage'],
      },
      // biome-ignore lint/suspicious/noThenProperty: JSON Schema if/then keyword
      then: { required: ['coveragePath'] },
    },
  ],
  // No `additionalProperties: false` — unknown keys warn at resolver time
  // (AC19) rather than failing validation.
};

/**
 * `quality.maintainability` carries only the per-file MI targetDirs. The
 * `crap` block was lifted out one level (it is now `quality.crap`) so the
 * grouped quality bag has a flat top-level for each enforcement engine
 * instead of CRAP being a nested concern of MI. See Epic #730 Story 6.
 */
const MAINTAINABILITY_QUALITY_SCHEMA = {
  type: 'object',
  properties: {
    targetDirs: LIST_OR_EXTENDER_OF_STRINGS,
  },
  additionalProperties: false,
};

const RELEASE_SCHEMA = {
  type: 'object',
  properties: {
    docs: {
      type: 'array',
      items: { ...SAFE_STRING, minLength: 1 },
    },
    versionFile: NULLABLE_SAFE_STRING,
    packageJson: { type: 'boolean' },
    autoVersionBump: { type: 'boolean' },
  },
  additionalProperties: false,
};

/**
 * `agentSettings.limits.friction` — runtime friction-detector thresholds
 * (renamed from the flat `agentSettings.frictionThresholds` block in
 * Epic #730 Story 8). Lives nested under {@link LIMITS_SCHEMA} alongside
 * the count/budget/timeout limits. Post Epic #1030 Story #1042 the
 * cooldown emitter module is gone; friction events land on disk as
 * NDJSON via signals-writer.appendSignal.
 */
const FRICTION_LIMITS_SCHEMA = {
  type: 'object',
  properties: {
    repetitiveCommandCount: { type: 'integer', minimum: 1 },
    consecutiveErrorCount: { type: 'integer', minimum: 1 },
    stagnationStepCount: { type: 'integer', minimum: 1 },
    maxIntegrationRetries: { type: 'integer', minimum: 1 },
  },
  additionalProperties: false,
};

/**
 * `agentSettings.limits.signals` — detector thresholds for the
 * performance-signal taxonomy introduced in Epic #1030. Each nested block
 * tunes one detector (hotspot vs phase-baseline p95, rework edits-per-file,
 * churn target-repeat count, idle gap seconds, retry repeat count). Every
 * key is optional so an operator can override a single threshold without
 * re-listing the others; the resolver fills missing keys from
 * {@link LIMITS_DEFAULTS.signals}.
 */
const SIGNALS_LIMITS_SCHEMA = {
  type: 'object',
  properties: {
    hotspot: {
      type: 'object',
      properties: {
        p95Multiplier: { type: 'number', minimum: 0 },
      },
      additionalProperties: false,
    },
    rework: {
      type: 'object',
      properties: {
        editsPerFile: { type: 'integer', minimum: 1 },
      },
      additionalProperties: false,
    },
    churn: {
      type: 'object',
      properties: {
        repeatCount: { type: 'integer', minimum: 1 },
      },
      additionalProperties: false,
    },
    idle: {
      type: 'object',
      properties: {
        gapSeconds: { type: 'integer', minimum: 1 },
      },
      additionalProperties: false,
    },
    retry: {
      type: 'object',
      properties: {
        repeatCount: { type: 'integer', minimum: 1 },
      },
      additionalProperties: false,
    },
  },
  additionalProperties: false,
};

const RISK_GATES_SCHEMA = {
  type: 'object',
  properties: {
    heuristics: {
      type: 'array',
      items: { type: 'string', minLength: 1 },
    },
  },
  additionalProperties: false,
};

/**
 * `quality.prGate.checks` is the configurable lint/format/test trio
 * `git-pr-quality-gate.js` runs on every `/git-merge-pr` invocation. Renamed
 * from the flat `agentSettings.qualityGate` block in Epic #730 Story 6.
 */
const PR_GATE_SCHEMA = {
  type: 'object',
  properties: {
    checks: {
      type: 'array',
      items: { type: 'string', minLength: 1 },
    },
  },
  additionalProperties: false,
};

/**
 * Per-baseline shape used inside `agentSettings.quality.baselines`. Each entry
 * carries a required on-disk `path` (the canonical baseline file the
 * lint/CRAP/MI ratchet reads + writes) and an optional `refreshCommand` that
 * lets an operator override the default `update-*-baseline.js` invocation.
 */
const BASELINE_ENTRY_SCHEMA = {
  type: 'object',
  required: ['path'],
  properties: {
    path: { ...SAFE_STRING, minLength: 1 },
    refreshCommand: NULLABLE_NONEMPTY_SAFE_STRING,
  },
  additionalProperties: false,
};

/**
 * `agentSettings.quality` is the unified home for every enforcement engine in
 * the framework: ratchet baselines (Story 5.5), per-method MI targeting,
 * CRAP scoring, and the PR-gate command suite (Story 6). The old flat
 * `agentSettings.maintainability` and `agentSettings.qualityGate` blocks are
 * removed; consumers read via `getQuality(config)` or directly from
 * `settings.quality.*`.
 */
const QUALITY_SCHEMA = {
  type: 'object',
  properties: {
    baselines: {
      type: 'object',
      properties: {
        lint: BASELINE_ENTRY_SCHEMA,
        crap: BASELINE_ENTRY_SCHEMA,
        maintainability: BASELINE_ENTRY_SCHEMA,
      },
      additionalProperties: false,
    },
    maintainability: MAINTAINABILITY_QUALITY_SCHEMA,
    crap: MAINTAINABILITY_CRAP_SCHEMA,
    prGate: PR_GATE_SCHEMA,
  },
  additionalProperties: false,
};

/**
 * `agentSettings.limits.planningContext` — bounded planning-context budget
 * for the `--emit-context` planning scripts (Epic #817 Story 9). When the
 * full payload (Epic body + docsContext + PRD/TechSpec bodies) would exceed
 * `maxBytes`, planners switch to a summary representation that emits doc
 * names, headings, and bounded excerpts instead of full bodies. `summaryMode`
 * controls the decision: `auto` summarises only on overflow, `always` forces
 * summary regardless of size, `never` is identical to `--full-context`.
 */
const PLANNING_CONTEXT_SCHEMA = {
  type: 'object',
  properties: {
    maxBytes: { type: 'integer', minimum: 1024 },
    summaryMode: { type: 'string', enum: ['auto', 'always', 'never'] },
  },
  additionalProperties: false,
};

/**
 * `agentSettings.limits` is the grouped home for every count/budget/timeout
 * runtime ceiling (Epic #730 Story 8). The legacy flat
 * `maxInstructionSteps` / `maxTickets` / `maxTokenBudget` /
 * `executionTimeoutMs` / `executionMaxBuffer` keys move under here; the
 * `frictionThresholds` block becomes `limits.friction`. Epic #817 Story 9
 * added `planningContext` for bounded `--emit-context` payloads.
 */
const LIMITS_SCHEMA = {
  type: 'object',
  properties: {
    maxInstructionSteps: { type: 'integer', minimum: 1 },
    maxTickets: { type: 'integer', minimum: 1 },
    maxTokenBudget: { type: 'integer', minimum: 1 },
    executionTimeoutMs: { type: 'integer', minimum: 1 },
    executionMaxBuffer: { type: 'integer', minimum: 1 },
    friction: FRICTION_LIMITS_SCHEMA,
    planningContext: PLANNING_CONTEXT_SCHEMA,
    signals: SIGNALS_LIMITS_SCHEMA,
  },
  additionalProperties: false,
};

/**
 * `agentSettings.paths` is the grouped home for the framework's filesystem
 * roots. Story 7 (Epic #730) introduced the block with `agentRoot` /
 * `docsRoot` / `tempRoot` (hard-required) plus optional `auditOutputDir`.
 * Story 9 (Epic #773) rolled the seven legacy `*Root` flat keys
 * (`scriptsRoot`, `workflowsRoot`, `personasRoot`, `schemasRoot`,
 * `skillsRoot`, `templatesRoot`, `rulesRoot`) under here as proper named
 * properties — they keep their resolver defaults but no longer live at the
 * top of `agentSettings`. `additionalProperties: false` catches typos up
 * front; defaults are applied by {@link getPaths} in the resolver.
 */
const PATHS_SCHEMA = {
  type: 'object',
  required: ['agentRoot', 'docsRoot', 'tempRoot'],
  properties: {
    agentRoot: { ...SAFE_STRING, minLength: 1 },
    docsRoot: { ...SAFE_STRING, minLength: 1 },
    tempRoot: { ...SAFE_STRING, minLength: 1 },
    auditOutputDir: { ...SAFE_STRING, minLength: 1 },
    scriptsRoot: { ...SAFE_STRING, minLength: 1 },
    workflowsRoot: { ...SAFE_STRING, minLength: 1 },
    personasRoot: { ...SAFE_STRING, minLength: 1 },
    schemasRoot: { ...SAFE_STRING, minLength: 1 },
    skillsRoot: { ...SAFE_STRING, minLength: 1 },
    templatesRoot: { ...SAFE_STRING, minLength: 1 },
    rulesRoot: { ...SAFE_STRING, minLength: 1 },
  },
  additionalProperties: false,
};

/**
 * Grouped command fields. `typecheck` and `build` accept `null` to mean
 * "disabled" (Story 3 `null`-for-disabled convention); the others are
 * required-when-present non-empty strings. `additionalProperties: false`
 * so a misspelled command key fails validation up front.
 *
 * `formatCheck` / `formatWrite` were added in 5.35.2 so the close-validation
 * format gate and the story-close format-autofix step can target Prettier,
 * dprint, or any other formatter (rather than the hardcoded biome string the
 * close path used previously). Defaults stay biome to preserve behaviour for
 * repos that haven't set them.
 */
const COMMANDS_SCHEMA = {
  type: 'object',
  properties: {
    validate: { ...SAFE_STRING, minLength: 1 },
    lintBaseline: { ...SAFE_STRING, minLength: 1 },
    test: { ...SAFE_STRING, minLength: 1 },
    typecheck: NULLABLE_NONEMPTY_SAFE_STRING,
    build: NULLABLE_NONEMPTY_SAFE_STRING,
    formatCheck: { ...SAFE_STRING, minLength: 1 },
    formatWrite: { ...SAFE_STRING, minLength: 1 },
  },
  additionalProperties: false,
};

export const AGENT_SETTINGS_SCHEMA = {
  type: 'object',
  // The hard-required path roots (`agentRoot` / `docsRoot` / `tempRoot`)
  // moved under `paths` in Epic #730 Story 7 — see PATHS_SCHEMA.required.
  // The agentSettings-level `paths` block itself is required so a config
  // that omits the entire group still fails fast with a clear message.
  required: ['paths'],
  properties: {
    baseBranch: SAFE_STRING,
    docsContextFiles: { type: 'array', items: { type: 'string' } },
    release: RELEASE_SCHEMA,
    riskGates: RISK_GATES_SCHEMA,
    quality: QUALITY_SCHEMA,
    commands: COMMANDS_SCHEMA,
    paths: PATHS_SCHEMA,
    limits: LIMITS_SCHEMA,
  },
  // Locked in Epic #773 Story 9 — Story 9 rolled the seven `*Root` flat
  // keys under `paths.*`, leaving `baseBranch` as the only top-level
  // string field. With the patternProperties shortcut gone we can fail
  // closed: any unknown top-level key (typo, stale flat *Root, etc.) is
  // rejected up front instead of silently ignored.
  additionalProperties: false,
};

let _settingsValidator = null;

export function getSettingsValidator() {
  if (!_settingsValidator) {
    const ajv = new Ajv({ allErrors: true });
    _settingsValidator = ajv.compile(AGENT_SETTINGS_SCHEMA);
  }
  return _settingsValidator;
}
