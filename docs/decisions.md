# Architecture Decision Records (ADR)

## ADR 20260501-900a: Epic-centric workflow rework — four-skill split, single-session fan-out, retire GitHub triggers

**Status:** Accepted
**Date:** 2026-05-01
**Epic:** #900
**Story:** #918

### Context

The execution surface had accreted in three layers that no longer
matched the ticket model:

1. A **single mega-skill** (`/sprint-execute`) that routed by `type::`
   label (Epic Mode vs. Story Mode) and fanned out subprocess Claude
   sessions for each Story.
2. A **GitHub-triggered remote orchestrator** (`epic-orchestrator.yml`,
   `remote-bootstrap.js`, `agent::dispatching` / `agent::planning` /
   `agent::decomposing` trigger labels) that existed only to invoke the
   slash commands headlessly on a GitHub-hosted runner.
3. A **claim-based pool mode** (`pool-claim.js`, `lib/pool-mode.js`,
   `in-progress-by:<sessionId>` claim labels) that arbitrated no-id
   `/sprint-execute` launches across N web tabs.

In the operator's day-to-day flow — single Claude Code session, no
remote dispatch — every layer above was dead weight: extra labels, a
parallel YAML, a bootstrap script, subprocess machinery, a claim race,
and a routing CLI (`sprint-execute-router.js`) whose only job was to
reverse the single-CLI design. The "sprint" nomenclature itself
mismatched the Epic-centric ticket model on which everything sits.

Six framing questions drove the scope.

- **Q1.** Which trigger labels go? Just the three trigger-only labels, or
  the whole `agent::review-spec`/`agent::ready` set too?
- **Q2.** How does the wave loop fan out Stories — keep `claude -p`
  subprocesses, or use the Agent tool inside the single session?
- **Q3.** Should `task-execute` be its own slash command, or a path-
  included helper read inline by `/story-execute`?
- **Q4.** What is renamed in the sprint→epic sweep? Slash commands and
  helper `.md` files only, or top-level scripts and config keys too?
  Structured-comment markers? `lib/orchestration/*` paths?
- **Q5.** How does multi-level progress collation work — one shared
  `epic-run-progress` comment written by all levels, or per-level
  comments that parents collate?
- **Q6.** With remote triggers gone, what survives of the planner CLI
  surface? `--phase spec|decompose`? `--auto-dispatch`?
  `epic-plan-state` checkpoint?

### Decision

Adopt the answers below for Epic #900; defer alternatives to a future
ADR if the trade-off proves wrong.

- **Q1 — minimal label cleanup.** Delete only the three trigger-only
  labels: `agent::dispatching`, `agent::planning`, `agent::decomposing`.
  Keep `agent::review-spec`, `agent::ready`, `agent::executing`,
  `agent::review`, `agent::blocked`, `agent::done` — they still encode
  lifecycle state independent of triggers.
- **Q2 — single-session Agent-tool fan-out.** `/wave-execute` launches
  Story sub-agents through the Agent tool in one assistant turn (capped
  at `concurrencyCap`). No `claude -p` subprocess spawn, no headless
  `--dangerously-skip-permissions` contract, no idle-watchdog, no
  progress-log tailing via `Monitor`. Worktree filesystem isolation is
  preserved; only the process boundary disappears.
- **Q3 — `task-execute.md` is a helper, not a slash command.** The
  per-Task discipline (`## Instructions` reading, scope guard,
  `assert-branch`, conventional commit) is a procedural module read
  inline by `/story-execute` — not registered in `.claude/commands/`.
  Tasks are not directly executable; they are implemented by the
  parent Story's loop.
- **Q4 — rename the operator-visible surface; keep internal markers
  and lib paths.**
  - Renamed: slash commands (`/epic-plan`, `/epic-close`), the new
    skill files (`epic-execute.md`, `wave-execute.md`,
    `story-execute.md`), top-level scripts (`epic-plan*.js`,
    `story-*.js`, `epic-*.js`), helper `.md` files under
    `workflows/helpers/`, and the config key
    `agentSettings.sprintClose.runRetro` →
    `agentSettings.epicClose.runRetro` (with a one-release shim that
    logs a deprecation warning when the legacy key is read).
  - Kept: structured-comment markers (`epic-run-state`,
    `epic-plan-state`, `dispatch-manifest`, `story-init`,
    `code-review`, `retro-complete` — already epic-shaped where it
    matters; renaming would orphan history on existing Epics) and
    `lib/orchestration/*` module paths (internal facade decomposition;
    the public-facing renames already deliver the nomenclature win
    without churning every import path).
- **Q5 — per-level progress, parents collate.** `/story-execute` writes
  a `story-run-progress` structured comment per Task transition.
  `/wave-execute` reads child story progress comments and writes a
  wave-level rolled-up `wave-run-progress` comment. `/epic-execute`
  reads child wave progress and renders the wave-level table inside
  the operator-facing `epic-run-progress` summary at the top of the
  Epic. Each level owns the comment for its own children; no shared
  writer contention.
- **Q6 — drop dead planner flags; keep checkpoint.** With remote
  triggers gone, `/epic-plan` no longer needs `--phase spec|decompose`
  (existed only so two GH labels could fire two halves) or
  `--auto-dispatch` (applied `agent::dispatching`, which no longer
  exists). The unified two-phase flow with the operator confirmation
  gate is the only mode. The `epic-plan-state` checkpoint comment is
  retained — it costs nothing and helps re-plans.

### Rationale

The four-skill split mirrors how the engine already decomposes work
(`wave-scheduler`, `story-launcher`, `wave-observer` are existing
internal submodules); promoting them to slash commands lets the
operator stop or resume at any level and removes the "this skill
routes by label" indirection. Single-session Agent-tool fan-out trades
process isolation (which the worktree boundary already provided at the
filesystem level) for in-session context budget; in practice the wave
loop spends most of its time waiting on Story sub-agents and the
in-session model was never the bottleneck. Per-level progress
collation localises ownership of each comment to the level that
generates it — no two writers contend for the same comment marker —
at the cost of one extra structured-comment marker
(`wave-run-progress`) per wave, which is cheap.

The label-cleanup scope is deliberately narrow: deleting only the
three trigger-only labels means downstream consumers running existing
state machines on `agent::review`/`agent::done` see no change. The
config-key rename ships with a one-release shim so a typical
`.agentrc.json` update is a no-op until 5.32.0.

### Implications

- **For operators.** The `/sprint-*` muscle memory is gone. New flow:
  `/epic-plan <id>` → `/epic-execute <id>` → `/epic-close <id>`. For
  a single Story off the dispatch table, run `/story-execute <id>`
  directly. The four-skill split lets you stop or resume at any
  level.
- **For repos that used the GitHub-trigger path.** That surface is
  deleted. The `agent::dispatching` label, the
  `epic-orchestrator.yml` workflow, and the `remote-bootstrap.js`
  script are gone. Drive Epics from a local Claude Code session
  going forward; if you genuinely need a GitHub-Action driver,
  re-introduce it as an out-of-tree workflow that invokes the local
  CLI scripts directly.
- **For consumer `.agentrc.json` files.** Rename
  `agentSettings.sprintClose.runRetro` → `agentSettings.epicClose.runRetro`
  on your next edit. The legacy key still reads with a one-shot
  deprecation warning until removal in 5.32.0 (registered in
  `docs/deprecation-register.md`).
- **For sub-agent prompt budget.** Story sub-agents now share the
  parent session's context budget instead of getting a fresh
  subprocess. The Story prompt deliberately scopes to one Story so
  the budget remains predictable; a runaway Story burns parent
  budget rather than its own.
- **For history continuity.** Structured-comment markers and
  `lib/orchestration/*` paths are unchanged, so existing Epics in
  flight at the cutover boundary continue to validate against the
  same readers.

### References

- Epic #900 body — full goals, non-goals, story decomposition, and
  Q1–Q6 framing.
- ADR 20260427-868a — open-root dispatch-manifest schema +
  AJV fixture drift test (the pattern this Epic adopts for the
  `wave-run-progress` comment shape).
- `docs/deprecation-register.md` — registers the
  `sprintClose.runRetro` shim for removal in 5.32.0.
- `docs/CHANGELOG.md` 5.31.0 entry — consumer-visible migration
  block for this Epic.

---

## ADR 20260427-868a: Open-root dispatch-manifest schema; AJV fixture drift test as enforcement boundary

**Status:** Accepted
**Date:** 2026-04-27
**Epic:** #857
**Story:** #868

### Context

`.agents/schemas/dispatch-manifest.json` had `additionalProperties: false`
at the root and a `required` list pinned to one of two manifest variants
(epic-dispatch). The runtime emits two distinct manifest shapes:

1. **epic-dispatch** — written by `dispatcher.js` via `buildManifest()`
   in `.agents/scripts/lib/orchestration/manifest-builder.js`. Persisted to
   `temp/dispatch-manifest-<epicId>.json`.
2. **story-execution** — returned by `executeStory()` in
   `.agents/scripts/lib/orchestration/story-executor.js`. In-memory only.

`buildManifest()` also emits fields the schema did not declare:
`storyManifest[].storyTitle`, `storyManifest[].type`,
`storyManifest[].tasks[].status`, and root-level `agentTelemetry`. With
`additionalProperties: false`, every fresh runtime field caused validation
failure. With a single-variant `required` list, the story-execution shape
could not be validated by the same schema at all.

Two design options were considered:

- **Strict-with-explicit-fields.** Keep `additionalProperties: false` and
  exhaustively list every emitted field. Catches all drift, including new
  unannounced fields. Forces a schema commit for every new runtime field.
- **Open-root + drift test.** Drop root `additionalProperties: false`, list
  the known fields, and rely on a fixture-based AJV drift test running
  `buildManifest()` and `executeStory()` against representative inputs to
  catch shape regressions on every CI build.

### Decision

Adopt the **open-root + drift test** model. Concretely:

1. Drop `additionalProperties: false` at the schema root. Inner objects
   (`summary`, wave items, `dispatched[]`,
   `storyManifest[]`, `storyManifest[].tasks[]`, `stories[]`,
   `stories[].tasks[]`) keep `additionalProperties: false` — those shapes
   are stable and benefit from strict validation.
2. Use a `oneOf` discriminator on the root `type` field
   (`"epic-dispatch" | "story-execution"`) to gate variant-specific
   `required` fields. The epic-dispatch branch tolerates an absent `type`
   for back-compat with the current `buildManifest()` output; new emitters
   should set `type: "epic-dispatch"` explicitly.
3. Add the runtime fields to `properties`: root `agentTelemetry`
   (`object`, `additionalProperties: true`); `storyManifest[].storyTitle`;
   `storyManifest[].type` (group classification:
   `"story" | "feature" | "ungrouped"`); `storyManifest[].tasks[].status`.
4. Add `stories[]` at the root for the story-execution variant.
5. Land the AJV fixture drift test
   (`tests/enforcement/manifest-schema.test.js`) in the same Story so the
   enforcement boundary is in place before the loosened root reaches main.

### Rationale

False-rejection has historically been the more disruptive failure mode for
this contract: a runtime field added without a schema commit blocks every
dispatch run that writes a manifest. Open-root with a CI-blocking drift
test inverts that bias — runtime additions ship without ceremony, but a
shape regression (missing required field, wrong type, wrong enum value)
fails the suite on the same commit that introduces it.

The AJV drift test is run on every CI build via `npm test`, so the
enforcement window is the same as the previous strict-root window. The
trade is "schema diff per new field" for "fixture diff when runtime shape
changes" — the latter is a coarser but more robust drift signal.

### Implications

- **For schema authors:** new optional runtime fields require no schema
  edit; new required fields must be added to the variant's `required`
  list AND covered by a fixture in `manifest-schema.test.js`.
- **For runtime authors:** emitted shape must validate against the schema;
  the AJV error path is surfaced verbatim by the drift test, so failures
  read as `instancePath: keyword` (e.g., `/storyManifest/0: required`).
- **For external consumers:** the schema describes a permissive root; do
  not rely on `additionalProperties: false` to reject unknown root keys.
  Inner objects remain strict.

### Out of scope

- **Splitting into `dispatch-manifest.epic-dispatch.json` and
  `dispatch-manifest.story-execution.json`.** A second consumer needing
  the variants apart is the trigger for that split; today's single-file
  `oneOf` is simpler.
- **Adding `agentTelemetry` to `required`.** Optional by design; the
  executor decides whether to attach telemetry.

## ADR 20260426-829a: Strip-then-analyze for TypeScript scoring; keep typhonjs-escomplex

**Status:** Accepted
**Date:** 2026-04-26
**Epic:** #829

### Context

The maintainability and CRAP gates only scored `.js` and `.mjs`. TS-first
consumer repos (e.g. athlete-portal) hit a degenerate state on
`agent-protocols` 5.28.1: 21 candidate files scanned, 0 rows written,
because every `.js`/`.mjs` candidate was build-time scaffolding (eslint
configs, `astro.config.mjs`) not exercised by tests. The actual product
surface — TypeScript — was invisible to both gates, so neither
maintainability nor CRAP could produce a useful baseline against the
code consumers care about. Cyclomatic-complexity gating on the real
source was impossible.

The kernel — `typhonjs-escomplex@0.1.0` — uses an Esprima parser that
rejects TypeScript type annotations and JSX outright.

### Decision

Pre-transpile TypeScript and TSX sources to plain JavaScript in memory
via `ts.transpileModule`, then feed the result to the existing escomplex
kernel. `JsxEmit.ReactJSX` is used so JSX expressions become function
calls escomplex can read; `JsxEmit.Preserve` would leave JSX in the
output and Esprima would choke.

Rationale for keeping escomplex rather than swapping kernels:

1. **Type annotations carry no control flow.** `if (x: string)` and
   `if (x)` produce identical cyclomatic and cognitive complexity.
   A TS file's score via strip-then-analyze equals what its
   `tsc --target esnext` JS output would score under escomplex —
   semantics-preserving for every metric the kernel emits.
2. **Existing JS-only consumers see no scoring drift.** The CRAP
   `kernelVersion` bump (1.0.0 → 1.1.0) and MI report kernel bump
   (1.0.0 → 1.1.0) are version-label changes only; the per-file and
   per-method scores for unchanged JS sources are byte-identical.
   A snapshot test in `tests/baselines-byte-identical-js-only.test.js`
   pins this contract.
3. **Replacing escomplex is a multi-week project.** A `ts-morph` +
   custom walker rewrite would invalidate every consumer's committed
   baseline, force a coordinated refresh across the install base, and
   bake in a new kernel that hasn't seen the years of edge-case
   hardening escomplex has. The strip-then-analyze approach piggybacks
   on a battle-tested kernel and ships in a single point release.

`tsTranspilerVersion` is added to the CRAP baseline envelope so
consumers can detect transpiler drift. Both `kernelVersion` and
`tsTranspilerVersion` mismatches **warn**, not fail — consumers
pin-and-bump and need runway to refresh deliberately rather than
discovering the version bump from a hard CI red. `escomplexVersion`
mismatch continues to fail closed: a different kernel can change
scoring semantics without warning, which is exactly the silent drift
the gate exists to catch.

### Alternatives considered

- **Replace `typhonjs-escomplex` with a TS-native walker (`ts-morph`).**
  Rejected. Multi-week effort, kernel risk, and a forced baseline
  refresh across all consumers with no compensating gain in scoring
  fidelity for the JS path.
- **Run a TS strip via custom regex / `@swc/core` / `esbuild`.**
  Rejected. Each adds a dep that's heavier than `typescript` (which
  most consumers already have as a dev-dep) and offers no upside over
  `ts.transpileModule` for this use case.
- **Use `tsc --noEmit` for a project-wide compile.** Rejected. Requires
  a resolvable `tsconfig.json` in the consumer; we deliberately don't
  trust consumer tsconfigs because they may reference paths the gate
  has no business resolving.

### Known limitations

`ts.transpileModule` does not preserve source line numbers verbatim.
JSX runtime imports add a leading line; interface elision shifts
subsequent code. Per-method coverage lookup against a vitest
`coverage-final.json` (which keys lines on the source) will see drifted
line numbers from escomplex (which sees the transpiled output). The
existing `compareCrap` line-drift fallback (same file + method, nearest
startLine wins) absorbs this for baseline comparison; per-method
coverage values may resolve to null on the first scan of a new TS
method, in which case the row is skipped from the baseline rather than
scored as zero. Sourcemap-based line remapping is a future enhancement
and out of scope for 5.29.0.

### Consequences

TS-first repos can adopt the gates without rewriting their build to
emit JS. Existing JS-only repos see a one-time warning on first
`crap:check` / `maintainability:check` after upgrading, directing them
to `npm run crap:update` / `npm run maintainability:update`. Their
score numbers don't change. The scoring kernel is unchanged, so future
ADRs about complexity ranges and tier thresholds remain valid.

## ADR 20260425-773a: CRAP gate becomes hard-enforcing

**Status:** Accepted
**Date:** 2026-04-25
**Epic:** #773

### Context

The CRAP gate (Change Risk Anti-Patterns: `c² · (1 − cov)³ + c`) shipped in
the codebase but no canonical `baselines/crap.json` existed because no
automated coverage capture flowed into the gate. The gate self-skipped on
the missing baseline, producing false-clean reports across all three
firing sites (close-validation, pre-push, CI).

### Decision

Bootstrap `baselines/crap.json` from a real `npm run test:coverage` +
escomplex pass and ship it as the canonical baseline. Remove the
informational early-return from `check-crap.js` so a missing baseline
becomes a hard fail with a clear bootstrap-instruction message at all
three firing sites. Operators bootstrap explicitly via
`npm run crap:update` + a `baseline-refresh:` commit.

### Consequences

A regression now actually blocks merge instead of producing a false
"clean" report. The top-10 method hotspots above CRAP 50 were eliminated
in the same Epic; the long-tail of ten methods at CRAP 50–72 is tracked
as a follow-on story.

## ADR 20260425-773b: Decompose two further large modules behind byte-identical facades

**Status:** Accepted
**Date:** 2026-04-25
**Epic:** #773

### Context

`providers/github.js` and `lib/worktree/lifecycle-manager.js` were the
next two MI-ratchet outliers after the v5.13.0 facade pass. Both had
absorbed ~50% growth since the previous decomposition and were now the
single largest concentrations of provider-side and worktree-side code.

### Decision

Apply the **facade + responsibility-bounded submodules** pattern (already
documented in `docs/patterns.md`) to both. Each top-level file becomes a
≤250 LOC facade re-exporting submodules under `providers/github/*` and
`lib/worktree/lifecycle/*`. Submodules thread a shared `ctx` rather than
importing each other (ctx-threading discipline). Public class surface and
import paths stay byte-identical; only internals move.

### Consequences

Same pattern as v5.13.0, three more concrete applications. Future growth
in either area lands in a focused submodule rather than re-bloating the
facade. Tests pass unchanged because the public surface is preserved.

## ADR 20260425-730a: Consolidate `agentSettings` into a grouped, schema-validated contract

**Status:** Accepted
**Date:** 2026-04-25
**Epic:** #730

### Context

`.agentrc.json` had accumulated a flat `agentSettings` namespace with ~25
peer keys spanning paths, commands, quality gates, limits, and friction
thresholds. The shape made three problems compounded over time:

1. **Discoverability.** A new operator could not tell which keys were
   required, which had defaults, or how related keys grouped — there was no
   typed surface for tooling and no canonical reference for humans.
2. **Validation gaps.** `agentSettings` was schema-permissive; typos in
   optional keys (e.g. `riskGates.heuristics`) silently disappeared during
   the previous template-diff sync, and the resolver's code-level fallbacks
   masked missing required values until a script blew up downstream.
3. **Baseline drift.** Three canonical ratchet baselines lived in three
   different locations under three different naming conventions, and the
   epic-runner's per-wave drift snapshots collided in repo-wide greps with
   the canonical files.

### Decision

Reorganise `agentSettings` into four typed sub-blocks
(`paths`, `commands`, `quality`, `limits`), unify the canonical ratchet
baselines under `/baselines/`, and drive the sync helper from the schema
instead of a structural diff against the template.

Concretely:

- **Grouped contract.** Every former flat key moves under one of the four
  sub-blocks. There are no flat-key reads anywhere in the resolver or in any
  consumer; each sub-block is read through a typed accessor (`getPaths`,
  `getCommands`, `getQuality`, `getLimits`).
- **Hard-required `paths`.** `paths.agentRoot`, `paths.docsRoot`, and
  `paths.tempRoot` are schema-required. The resolver no longer applies
  code-level `?? '.agents'` / `?? 'docs'` / `?? 'temp'` fallbacks; a missing
  value is a validation error with a clear `instancePath`.
- **`null` for disabled commands.** `commands.typecheck` and `commands.build`
  accept `string | null`; an empty string is rejected. `null` is the
  canonical "not applicable" value.
- **Conditional `orchestration.github` requirement.** When
  `orchestration.provider` is `"github"`, the `github` block (with required
  `owner` and `repo`) is schema-required.
- **Static JSON Schema mirror.** Both shipped configs declare
  `"$schema": "./.agents/schemas/agentrc.schema.json"`. The runtime AJV
  schemas in `lib/config-schema.js` and `lib/config-settings-schema.js`
  remain authoritative; the static mirror exists for editor tooling and
  human readers, kept in sync by a drift test.
- **Schema-driven sync helper.** `agents-sync-config` now validates the
  project config against the schema, adds template-introduced keys, and
  preserves every project-side key that validates — including optional keys
  absent from the template (e.g. `orchestration.concurrency`, `closeRetry`,
  `poolMode`). Validation failures abort with a diagnostic instead of
  silently stripping unknown keys.
- **Canonical baselines under `/baselines/`.** `baselines/lint.json`,
  `baselines/crap.json`, and `baselines/maintainability.json` are the
  default-configured paths. The epic-runner's per-wave drift snapshots use
  intentionally distinct filenames (`wave-mi-snapshot.json`,
  `wave-crap-snapshot.json`) under `.agents/state/` so a repo-wide grep
  never confuses one with the other.
- **New configuration reference doc.** `docs/configuration.md` documents
  every configurable key, its default, whether it is required, and the
  baseline conventions. The `.agents/README.md` "Key Settings" table is
  the high-traffic subset; the doc is the canonical source.

### Consequences

- **Breaking for consumers carrying flat-shaped configs.** Migration is
  mechanical (every former flat key has a single grouped equivalent) and
  documented in the v5.26.0 changelog entry. Validation now fails closed,
  so operators learn about misconfiguration at startup instead of at the
  call site that needed the missing value.
- **Editor support comes for free.** Any editor with JSON Schema support
  picks up autocomplete and inline validation from the `$schema` pointer.
- **Future schema changes are cheaper.** Adding a new sub-block in the
  grouped shape is a localised change (one schema edit, one resolver
  accessor, one row in the reference doc); previously the same change
  threaded through multiple flat-key sites.
- **Sync helper trades silent strip for loud abort.** A typo in an optional
  key now aborts the sync with a diagnostic instead of vanishing on round-
  trip. Operators see misconfiguration; the rare false-positive abort is
  the right trade.

### Alternatives considered

- **Keep the flat shape, add a doc.** Rejected: documentation alone does
  not fix the validation gap or the silent-strip behaviour, and the
  resolver's flat-key fallbacks would still mask missing required values.
- **Split `.agentrc.json` into multiple files** (one per concern).
  Rejected: increases the surface operators must reason about and the sync
  helper must reconcile. A single file with a typed grouped shape captures
  the same separation without the file-count tax.
- **Keep `crap-baseline.json` and `maintainability-baseline.json` at repo
  root.** Rejected: collides in greps with the per-wave drift snapshots
  and offers no upside over the unified `/baselines/` directory.

---

## ADR 20260424-702a: Retire agent-protocols MCP

**Status:** Accepted
**Date:** 2026-04-24
**Epic:** #702

**Supersedes:** ADR-20260422-441b (_Canonical structured-comment writer is the MCP tool_),
which is retained below for historical context only — its conclusion no longer
applies now that the MCP server is gone.

### Context

Version 5.0 introduced the `agent-protocols` MCP server
(`.agents/scripts/mcp-orchestration.js`) as a JSON-RPC 2.0 facade over the
orchestration SDK. The stated goal was letting an MCP-capable host (Claude
Desktop, Cursor) call `dispatch_wave`, `hydrate_context`,
`transition_ticket_state`, `cascade_completion`, `post_structured_comment`,
`select_audits`, and `run_audit_suite` natively instead of spawning shell
subprocesses.

By early 2026-04 two costs had compounded against that value:

- **Surface duplication.** Every orchestration capability already shipped as
  a Node CLI wrapper around the same SDK (`dispatcher.js`,
  `context-hydrator.js`, `update-ticket-state.js`,
  `post-structured-comment.js`, `audit-orchestrator.js`). The MCP server was
  a second entry point to the same code path — two schemas to keep in sync,
  two permission surfaces to validate, two places for a structured-comment
  marker to drift. Epic #380's retro-routing regression (a retro body was
  mis-posted through the webhook because the MCP tool's `type` enum missed
  `retro`) and Epic #441's marker-shape fixes (ADR-20260422-441b) were both
  direct consequences of that duplication.
- **Operator ergonomics.** `.mcp.json` became the canonical home for
  `NOTIFICATION_WEBHOOK_URL` (v5.8.0 consolidation), which meant operators
  had to provision one file for secrets that their IDE's MCP host would
  also read. Fresh checkouts needed the file before `/sprint-execute` would
  find a webhook. Worktrees had to bootstrap-copy it into every isolated
  tree. Every surface that resolved the webhook had to traverse two code
  paths. Epic #710 traced the leak behaviour documented in the operator
  memory entry _feedback_webhook_leak_in_tests.md_ back to this dual
  sourcing.

### Decision

Retire the `agent-protocols` MCP server and its companion artefacts:

- Delete `.agents/scripts/mcp-orchestration.js` and everything under
  `.agents/scripts/lib/mcp/` and `.agents/scripts/mcp/`.
- Delete the dedicated MCP docs (`.agents/MCP.md`, `docs/mcp-setup.md`).
- Drop the `agent-protocols` block from `.agents/default-mcp.json` and stop
  shipping a template that advertises the server.
- Collapse webhook resolution to env-only: `NOTIFICATION_WEBHOOK_URL` is
  read from the process environment (loaded from `.env` locally, or set in
  the Claude Code web environment-variables UI). `.mcp.json` is no longer
  consulted.
- Keep the existing Node CLI wrappers under `.agents/scripts/` as the sole
  consumer interface to the orchestration SDK.

Third-party MCP servers an operator wants to wire into their IDE
(`@modelcontextprotocol/server-github`, `context7`, etc.) remain
unaffected — `.mcp.json` is still a valid file in that role, it just
doesn't carry a framework-shipped entry anymore.

### Where the capabilities live now

| Retired MCP tool                               | Successor                                                                                                                                    |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `mcp__agent-protocols__dispatch_wave`          | `node .agents/scripts/dispatcher.js --epic <id>` (same SDK, same dispatch-manifest output).                                                  |
| `mcp__agent-protocols__hydrate_context`        | `node .agents/scripts/hydrate-context.js --ticket <id> --epic <id>` for the JSON envelope; `context-hydrator.js` remains the raw-prompt wrapper. |
| `mcp__agent-protocols__transition_ticket_state`| `node .agents/scripts/update-ticket-state.js --task <id> --state <state>` (auto-cascades on `agent::done`).                                  |
| `mcp__agent-protocols__cascade_completion`     | Inlined into `update-ticket-state.js`; also runs at Story close inside `story-close.js`.                                              |
| `mcp__agent-protocols__post_structured_comment`| `node .agents/scripts/post-structured-comment.js --ticket <id> --marker <marker> --body-file <path>`; direct `provider.postComment` in lib code. |
| `mcp__agent-protocols__select_audits`          | `node .agents/scripts/select-audits.js --ticket <id> --gate <gate>`.                                                                         |
| `mcp__agent-protocols__run_audit_suite`        | `node .agents/scripts/run-audit-suite.js --audits <comma-list>`.                                                                             |

The SDK modules under `.agents/scripts/lib/orchestration/` (the things
these tools delegated into) are unchanged — the retirement is a surface
removal, not a logic change.

### Consequences

- **Positive:** One entry point per capability; one schema per argument
  shape; one place for a marker contract to live. Structured-comment
  `type` drift (ADR-20260422-441b) is no longer a possible failure mode
  because there is no parallel writer.
- **Positive:** `.mcp.json` is no longer load-bearing for framework
  orchestration. Operators provision secrets in `.env` (local) or the
  Claude Code web env-var UI (web); `.mcp.json` is reserved for the
  MCP host's own discovery of third-party servers.
- **Positive:** Worktree bootstrap drops `.mcp.json` from its copy list;
  one fewer file to keep in sync across isolated trees.
- **Negative (breaking):** Operators who previously relied on the IDE
  invoking tools natively must now invoke the Node CLIs directly (or let
  the `/sprint-*` workflows invoke them, which they already did). The
  CLI mapping above is the migration list.
- **Negative (breaking):** Operators who kept `NOTIFICATION_WEBHOOK_URL`
  or `GITHUB_TOKEN` only in `.mcp.json` must move them to `.env` (local)
  or the Claude Code web env-var UI. The notifier resolver no longer
  reads `.mcp.json`.
- **Negative (fork-aware):** Consumer repos that pulled
  `.agents/default-mcp.json` into their own `.mcp.json` must remove the
  `agent-protocols` entry during their next submodule bump; leaving it
  in place resolves to a now-missing script path.

### Alternatives considered

- **Keep the MCP server, deduplicate the schemas.** Rejected: the
  duplication was *between* the MCP tool layer and the CLI wrappers, not
  within the tool layer. Consolidating one side still leaves two surfaces.
- **Delete the Node CLIs instead, keep MCP as the only surface.** Rejected:
  the CLIs are invoked directly by the `/sprint-*` workflows, by
  `remote-bootstrap.js` under GitHub Actions, and by consumer projects'
  own scripts. They are not optional; the MCP server was.
- **Keep the MCP server but move webhook resolution to env-only.**
  Rejected: solves the leak symptom without addressing the duplication
  cost. The Epic #710 audit concluded the surface itself was the
  liability, not the specific webhook lookup.

---

## ADR 20260424-668a: Resolve `worktreeIsolation.enabled` from environment, not config

**Status:** Accepted
**Date:** 2026-04-24
**Epic:** #668

### Context

Two execution environments coexist for `/sprint-execute`: local Claude Code
sessions on a developer machine (one shared filesystem, multiple agents) and
web Claude Code sessions at claude.ai/code (each session is its own sandboxed
clone). The shared-filesystem coordination problem that `.worktrees/` solves
locally does not exist on web — the session itself is already an isolated
clone. A single committed `orchestration.worktreeIsolation.enabled` value
cannot serve both: flipping it between local and web runs would pollute git
history and confuse other contributors.

### Decision

`orchestration.worktreeIsolation.enabled` becomes a **resolved** value, not
just a read value. `resolveWorktreeEnabled(opts, env)` in
`lib/config-resolver.js` consults environment signals before falling back to
the committed config. Precedence:

1. `env.AP_WORKTREE_ENABLED === 'true'` → `true` (explicit operator override).
2. `env.AP_WORKTREE_ENABLED === 'false'` → `false` (explicit operator
   override).
3. `env.CLAUDE_CODE_REMOTE === 'true'` → `false` (web-session auto-detect).
4. Otherwise → committed `orchestration.worktreeIsolation.enabled`.

The same resolver also publishes `runtime.sessionId`, preferring
`CLAUDE_CODE_REMOTE_SESSION_ID` when available (set automatically inside web
sessions) and falling back to a hostname+pid+random short-id. The committed
config is read-only at runtime; no workflow writes it.

### Consequences

- **Positive:** One committed config, two execution environments, no git-
  history thrash. Web sessions auto-disable worktrees; local sessions retain
  the v5.7.0 isolation behaviour. Operators can force either mode locally with
  one env var.
- **Positive:** `runtime.sessionId` is available as a stable per-process
  identity surfaced in the startup `[ENV] sessionId=…` log line for
  operator log-correlation, with no separate identity layer required.
  *(The original consumer of this id — the claim-protocol pool mode —
  was retired in story #909; the field is preserved for diagnostics
  only.)*
- **Negative:** The resolver consumes process environment, not config — typos
  in env var names fall through silently to the next rule. Mitigated by
  string-equality matching (`'true'` / `'false'` literal) so `"0"` / `""` /
  truthy-but-non-matching values cannot accidentally flip the flag.
- **Negative:** The worktree-off path is exercised less often than the
  worktree-on path on local machines. Mitigated by a diff test that runs the
  same fixture both ways and asserts the on-branch logs are byte-identical to
  a saved baseline.

### Alternatives considered

- **Two committed configs (`.agentrc.web.json` / `.agentrc.local.json`).**
  Rejected: would require runtime selection logic anyway and operators would
  still hand-edit one to ship.
- **Auto-detect via `git worktree list` size or filesystem inspection.**
  Rejected: indirect signal, unreliable in CI and exotic environments. The
  explicit `CLAUDE_CODE_REMOTE` marker Anthropic ships in web is the right
  contract.
- **Dedicated `/sprint-execute-web` slash command.** Rejected: forks the
  codepath. The Epic's hard requirement was operator parity — the same
  command, with the same contract, working in both environments.

---

## ADR 001: Autonomous Protocol Refinement Loop

**Status:** Reverted (Moved to manual process)  
**Date:** 2026-04-09  
**Epic:** #74

### Context
Frequent friction during agent execution (e.g., tool misuse, prompt ambiguity) requires manual protocol updates. This creates a bottleneck and prevents the system from scaling its efficiency.

### Decision
We will implement an autonomous, closed-loop system that:
1.  Ingests friction logs from completed tasks.
2.  Uses an LLM-based agent to identify patterns and propose protocol updates.
3.  Automatically creates PRs for these updates.
4.  Tracks the performance impact post-merge.

### Consequences
*   **Positive:** Reduced manual maintenance, faster protocol maturation, data-driven improvement.
*   **Negative:** Increased GitHub API usage, potential for low-quality automated PRs if prompts are weak.
*   **Mitigation:** Human-in-the-loop (HITL) requirement for merging refinement PRs.

---

## ADR 002: Real-time Sprint Health Monitoring

**Status:** Accepted  
**Date:** 2026-04-09  
**Epic:** #74

### Context
Operators lack visibility into "stalled" sprints or widespread tool failures during parallel task execution.

### Decision
Implement a single-issue "Sprint Health" dashboard in GitHub that is updated via `health-monitor.js` after every major task state transition.

### Consequences
*   **Positive:** Immediate visibility into systemic failures.
*   **Negative:** High edit frequency on a single issue might trigger GitHub rate limits.
*   **Mitigation:** Debounced updates and batching metrics.

---

## ADR 003: Worktree-per-Story Isolation for Parallel Sprint Execution

**Status:** Accepted
**Date:** 2026-04-15
**Epic:** #229
**Version shipped:** 5.7.0

### Context

Parallel sprint execution prior to v5.7.0 shared one working tree across all
story agents. On 2026-04-14, five concurrent agents under `epic/267` raced on
branch checkouts and swept a WIP file from one story into another story's
commit. v5.5.1 shipped three symptomatic fixes (tri-state Epic branch
bootstrap, pre-commit `assert-branch.js`, focus-area wave serialization). These
prevented the specific failure modes observed but did not address the root
cause: multiple agents mutating one working tree at the same time.

### Decision

Each dispatched story runs in its own `git worktree` at
`.worktrees/story-<id>/`. A single `WorktreeManager` owns the worktree
lifecycle (`ensure` / `reap` / `list` / `isSafeToRemove` / `gc`). The
dispatcher constructs a manager when
`orchestration.worktreeIsolation.enabled` is `true` and threads the worktree
path as `cwd` through the execution adapter. Single-tree mode remains a
first-class fallback via `enabled: false`.

Supporting decisions:

- **Bounded `git worktree remove --force` only after safety checks.** Dirty
  unmerged trees still refuse to delete, but a clean or already-merged
  removable worktree may use a single force retry after Windows lock/cwd
  retry exhausts.
- **`core.longpaths=true`** set per worktree on win32; a pre-flight
  path-length warning is posted on the Epic issue when the estimated deepest
  path exceeds the configured threshold.
- **`gitFetchWithRetry`** retries only on known packed-refs lock-contention
  signatures; unrelated fetch failures surface immediately. No global mutex
  — that would erase the parallelism the model is designed to enable.
- **`node_modules` strategy is explicit**: `per-worktree` (default, correct
  everywhere), `symlink` (requires `primeFromPath`; Windows opt-in via
  `allowSymlinkOnWindows`), `pnpm-store` (agent runs `pnpm install` against
  the shared store).

### Consequences

*   **Positive:**
    *   Main-checkout reflog stays quiet during parallel sprints; agent
        activity is confined to per-worktree reflogs.
    *   Defense-in-depth preserved: `assert-branch.js` and focus-area
        serialization remain in place for the fallback mode and as second-
        line guards in worktree mode.
    *   Fallback mode works with existing v5.5.1 tests unchanged.
*   **Negative:**
    *   Increased disk usage for `per-worktree` install strategy; `symlink`
        and `pnpm-store` mitigate at the cost of platform fragility.
    *   Windows long-path handling requires explicit operator attention
        when the worktree root nests deeply.
    *   Concurrent `git fetch` can collide on `.git/packed-refs.lock`;
        handled by bounded retry rather than a global lock.
*   **Mitigation:**
    *   `worktree-lifecycle.md` documents the model, Windows notes, and
        escape hatches.
    *   Real-git integration test (`tests/integration/parallel-sprint.test.js`)
        asserts AC6 (no WIP cross-contamination across five concurrent
        stories) and AC7 (main-checkout reflog quiet) on every run.

---

## ADR 004: Gherkin Standards as Sole SSOT for BDD Tags & Forbidden Patterns

**Status:** Accepted
**Date:** 2026-04-19
**Epic:** #269

### Context

Epic #269 introduces a BDD authoring framework: one rule
(`.agents/rules/gherkin-standards.md`), two skills
(`skills/stack/qa/gherkin-authoring`, `skills/stack/qa/playwright-bdd`), one
workflow (`/run-bdd-suite`), and a pyramid-aware rewrite of
`testing-standards.md`. Without a single source of truth for the tag taxonomy
and forbidden patterns, the two skills and every consuming project would
inevitably drift into parallel vocabularies — exactly the failure mode that
made Cucumber suites unmaintainable in earlier industry cycles.

### Decision

`.agents/rules/gherkin-standards.md` is the **sole** SSOT for:

- the canonical tag taxonomy (`@smoke`, `@risk-high`, `@platform-*`,
  `@domain-*`, `@flaky`);
- the forbidden-pattern list (SQL/ORM calls, status codes, DOM selectors, raw
  URLs, payloads, framework names, explicit waits);
- Scenario Outline conventions, selector discipline, and the step-reuse
  protocol.

Skills and workflows MUST reference the rule rather than restate it. Additions
to the taxonomy require a PR that updates the rule before use. The
`testing-standards.md` pyramid rule is the companion SSOT for tier-placement of
assertions; acceptance-tier scenarios defer shape-of-data concerns to contract
tests rather than encoding them in `.feature` files.

### Consequences

*   **Positive:**
    *   One place to look for the tag grammar; reviewers can mechanically
        reject unknown tags.
    *   `gherkin-authoring` and `playwright-bdd` stay focused on *how* and
        *when* without redefining *what*.
    *   The audit from Task #294 becomes a repeatable pattern — grep the
        skills for redefinition, point at the rule.
*   **Negative:**
    *   Rule-level changes are higher friction than editing a skill; adding a
        new domain tag requires a PR to the rule.
*   **Mitigation:**
    *   `@domain-<slug>` is extensible by design — consumers pick their own
        slug without touching the rule. Only the top-level tag *categories*
        are closed.

---

## ADR: Decompose oversized orchestration modules via facade pattern

**Status:** Accepted
**Date:** 2026-04-20
**Epic:** #297

### Context

Three orchestration-SDK modules grew past the point where a single file
usefully described a single responsibility: `lib/worktree-manager.js`
(1,234 LOC), `lib/orchestration/dispatch-engine.js` (874 LOC), and
`lib/presentation/manifest-renderer.js` (600 LOC). The 5.12.3 clean-code
audit flagged them as the top structural-complexity outliers in the
repository. The DRY portion of the audit had already been addressed via
new shared utilities (`lib/risk-gate.js`, `lib/label-constants.js`,
`lib/path-security.js`, `lib/error-formatting.js`,
`lib/issue-link-parser.js`). What remained was purely a structural
decomposition.

### Decision

Split each target file into cohesive submodules, then reduce the original
file to a **thin facade** that re-exports the same public symbols.

- `lib/worktree-manager.js` → 223-LOC facade composing `lib/worktree/`
  submodules (`lifecycle-manager`, `node-modules-strategy`,
  `bootstrapper`, `inspector`).
- `lib/orchestration/dispatch-engine.js` → 196-LOC coordinator composing
  `wave-dispatcher`, `risk-gate-handler`, `health-check-service`,
  `epic-lifecycle-detector`, `dispatch-pipeline`, and `dispatch-logger`.
- `lib/presentation/manifest-renderer.js` → 175-LOC facade composing
  `manifest-formatter` (pure) and `manifest-persistence` (fs I/O).

The facade files are the **only** part of the stable public surface;
submodule paths are internal implementation detail.

### Consequences

*   **Positive:**
    *   No caller needs to change — `dispatcher.js`,
        `mcp-orchestration.js`, `sprint-story-{init,close}.js`, and every
        test file continue to import from the existing paths.
    *   Each submodule owns one responsibility and is individually
        unit-testable; 65 new per-submodule tests landed alongside the
        refactor (13 manifest + 35 worktree + 17 orchestration).
    *   Future behaviour changes touch the submodule that owns the
        concern, not a 1,000-LOC grab-bag.
*   **Negative:**
    *   The facade carries a handful of backwards-compat `_*` delegate
        methods on `WorktreeManager` so the existing 46-test
        `worktree-manager.test.js` keeps passing without edits. They are
        technical debt to be retired once those tests migrate to
        per-submodule imports.
    *   One new lazy-VerboseLogger implementation (`dispatch-logger.js`)
        duplicates the pattern used elsewhere in the codebase.
*   **Mitigation:**
    *   Retro action items track both the delegate retirement and the
        lazy-logger consolidation.
    *   Downstream consumers are explicitly told (in `architecture.md`
        and this ADR) that only the facade paths are stable — submodule
        paths may be renamed without a major version bump.

---

## ADR-20260421: Epic-level remote orchestration via GitHub label trigger

*   **Status:** Accepted (Epic #321, v5.14.0).
*   **Context:** Before v5.14.0 `/sprint-execute` was story-scoped and
    operator-driven: the operator picked Stories off the dispatch table
    and launched each in its own window. Wave advancement and bookend
    chaining (review → retro → close) were manual. The orchestration
    primitives to automate this already existed (`dispatch_wave`,
    `Graph.computeWaves()`, `cascadeCompletion`), but no long-running
    driver tied them together.
*   **Decision:** A new `/sprint-execute-epic` skill wraps a composed
    `EpicRunner` coordinator that walks the wave DAG, fans out per-story
    executor sub-agents (bounded by `concurrencyCap`), checkpoints
    progress on the Epic via the `epic-run-state` structured comment,
    and halts only at `agent::review` or on blocker escalation. A
    GitHub Actions workflow (`epic-orchestrator.yml`) fires on
    `agent::dispatching` label application, boots a Claude remote
    agent, and launches the same skill against the same engine. Local
    and remote runs share code path.
*   **Alternatives considered:**
    *   Build a separate "epic executor" service running outside
        GitHub — rejected because it would reinvent the dispatcher and
        require its own state store.
    *   Extend `/sprint-execute` to accept either Story or Epic IDs
        (single command, switch on type) — rejected for v5.14.0 to keep
        the rename/alias story clean; planned for Epic #349.
    *   Runtime HITL approval on every wave boundary — rejected; the
        Epic's whole value proposition is HITL-minimal execution.
*   **Consequences:**
    *   Three operator touchpoints on the happy path: dispatch,
        blocker resolution, review hand-off.
    *   `epic::auto-close` authorizes autonomous merge-to-main, so
        branch protection on `main` becomes the primary defense for
        destructive actions.
    *   `risk::high` runtime gating is retired (see ADR below); the
        label remains as retro-visible metadata.
    *   The remote-agent environment has a new secret surface
        (`ENV_FILE`, `MCP_JSON`, `GITHUB_TOKEN`); `::add-mask::` +
        `0600` file perms in `remote-bootstrap.js` are the contract.

---

## ADR-20260421: Retire `risk::high` runtime gating

*   **Status:** Accepted (Epic #321 Story #334, v5.14.0).
*   **Context:** `risk-gate-handler.js` halted the dispatcher on
    `risk::high` tasks, and `story-close.js` halted close for
    `risk::high` stories. In the new HITL-minimal model this becomes
    two per-ticket gates the orchestrator must pause on — incompatible
    with unattended remote runs.
*   **Decision:** The runtime halt is removed. `handleRiskHighGate`
    reduces to a log-only warning; `wave-dispatcher.js` dispatches
    `risk::high` tasks unconditionally; `story-close.js` gates
    only when both `hitl.riskHighApproval` **and**
    `hitl.riskHighRuntimeGate` are explicitly `true` (both default
    `false`). The label is preserved — retros and planning can still
    query it as metadata.
*   **Alternatives considered:** rename the label to
    `metadata::risk-high` to make its informational nature legible —
    deferred to Epic #349 as it is a breaking taxonomy change.
*   **Consequences:**
    *   Destructive-action containment moves from runtime approval to
        (a) GitHub branch protection on `main`, (b) executor sub-agent
        `agent::blocked` escalation when an unauthorized destructive
        action is detected, (c) `epic::auto-close` as a deliberate
        opt-in that must be set at dispatch.
    *   `handleHighRiskGate` in `story-close.js` becomes dead
        code behind a hidden opt-in flag — cleanup tracked in Epic
        #349 Wave 0.

---

## ADR-20260422: Two-stage Windows worktree reap (fs.rm retry + deferred sweep)

*   **Status:** Accepted (Epic #380 Story #386, v5.15.1).
*   **Context:** The v5.7.0 worktree-per-story model ships a clean
    `reap` path for POSIX, but on Windows `git worktree remove` + the
    follow-up `fs.rm` routinely fail with `EBUSY` / `ENOTEMPTY` because
    antivirus, indexing, and `node_modules` file handles hold the
    directory open for seconds after the merge completes. The v5.15.0
    symptom was `branchDeleted: false` from `/sprint-story-close` plus
    orphan `.worktrees/story-<id>/` residue that broke the next
    `npm run lint` (nested `biome.json` in the orphan was picked up).
*   **Decision:** Reap is now a two-stage operation inside
    `lifecycle-manager.js`:

    1. Primary path retries `fs.rm(..., { recursive: true, force: true,
       maxRetries, retryDelay })` on `EBUSY` / `ENOTEMPTY`.
    2. Anything still pinned after retry is queued into
       `.worktrees/.pending-cleanup.json` and drained on the next
       worktree-manager run by `worktree-sweep.js`.

*   **Explicitly rejected approaches:**
    *   **Shelling out to `rm -rf` / `cmd /c rd /s /q`** — makes the
        deletion opaque to Node, silently succeeds while antivirus is
        still scanning, and would require per-platform branching. The
        `fs.rm` retry path surfaces real errors and is test-drivable
        with an injected adapter.
    *   **Switching the default `node_modules` strategy to `symlink` or
        `pnpm-store`** to shrink the reap surface — rejected; the
        `per-worktree` strategy is the only one that is correct on every
        platform and CI image, and the original Epic #229 ADR
        (ADR 003) documents why. The Windows reap problem is worth
        fixing on its own terms without touching the install model.
    *   **Global mutex around reap** — rejected for the same reason the
        fetch path refused one: it would erase the parallelism the
        worktree model is designed to enable.
*   **Consequences:**
    *   `/sprint-story-close` reports `branchDeleted: true` on Windows
        across the common antivirus failure modes; the remaining tail
        is handled asynchronously by the sweep.
    *   New artefact: `.worktrees/.pending-cleanup.json` (see
        `docs/data-dictionary.md#8-epic-380-artefacts-v5151`).
    *   Orphan-worktree biome lint block (documented in operator
        auto-memory) disappears once the sweep drains a queued entry.

---

## ADR-20260422: `/sprint-retro` routes through provider.postComment, not notify.js

*   **Status:** Accepted (Epic #380 Story #388, v5.15.1).
*   **Context:** `notify.js` dispatches via the Make.com webhook
    configured in `orchestration.notificationWebhookUrl`. It is the
    right surface for operator pings ("your story needs review") but
    the wrong surface for retro bodies, which are long-form markdown
    with internal-only friction analysis. v5.15.0 routed retros through
    `notify.js`; the webhook forwarded every retro to Slack, leaking
    draft content and friction citations to channels that should never
    have seen them.
*   **Decision:** `/sprint-retro` posts the retro body via
    `provider.postComment` (or the MCP `post_structured_comment` tool
    when running under the MCP harness). The ticket issue is the SSOT
    for retros; no external webhook is invoked. A `retro-partial`
    structured-comment checkpoint is written during collection so a
    crashed retro resumes without re-reading the friction log.
*   **Alternatives considered:**
    *   Keep `notify.js` but filter retro payloads at the webhook side —
        rejected; the webhook is out-of-repo and out-of-review, so a
        filter there is not auditable from this repository.
    *   Write retros to a local file and upload as a gist — rejected;
        breaks the "GitHub issue is the SSOT" invariant the whole
        framework rests on.
*   **Consequences:**
    *   Operator memory entry `feedback_retro_github_only.md` is
        resolved at the framework level, not just as a per-project rule.
    *   `notify.js` is now scoped exclusively to short operator pings;
        its payload surface is correspondingly smaller.
    *   Retro resumption is a first-class flow: the `retro-partial`
        marker is idempotent and the final `retro-complete` upsert
        replaces it on success.

## ADR-20260422: Pre-wave spawn smoke-test + post-wave commit assertion

*   **Status:** Accepted (Epic #413 Stories #419 / #420, v5.15.2).
*   **Context:** The single highest-impact bug of Epic #380 was that
    every Story dispatched via the `defaultSpawn` adapter exited in ~3
    seconds without doing any work. A one-line Windows shell-quoting
    bug wasted a full 28-second "successful" wave. The fix landed
    mid-close as commit `6830fbe`, but nothing in the runtime path
    would have flagged the regression earlier than "wave reports done,
    no commits exist."
*   **Decision:** Two complementary guards are wired into the
    `epic-runner` coordinator:
    1.  `SpawnSmokeTest` (`lib/orchestration/epic-runner/spawn-smoke-test.js`)
        runs `claude --version` through the real `buildClaudeSpawn`
        shape before Wave 1 dispatches. A non-zero exit (or 5s
        timeout) halts the runner with a friction comment naming
        `CLAUDE_BIN`, the exit code, and stderr; the Epic flips to
        `agent::blocked`.
    2.  `CommitAssertion` (`lib/orchestration/epic-runner/commit-assertion.js`)
        runs after each wave reports `done`. It iterates the done
        Stories and confirms every `origin/story-<id>` has at least
        one new commit reachable from `origin/epic/<epicId>`. A
        zero-delta story reclassifies the wave as `halted`.
*   **Alternatives considered:**
    *   Rely on the close-time assertion alone — rejected; that
        already exists implicitly (no commits → close fails) but the
        feedback loop is too long. Catching the spawn bug at Wave 1
        instead of Wave N saves up to N × wave-duration of wasted run.
    *   Invoke `claude --version` once at runner load — rejected;
        the failure mode was specifically about the
        `--dangerously-skip-permissions` arg shape, which `--version`
        + a stub binary doesn't fully exercise. The smoke-test runs
        the real shape.
*   **Consequences:**
    *   The `defaultSpawn` regression class fails fast (in seconds, not
        a wave) and surfaces a structured friction comment on the
        Epic. Operators no longer need to read the runner stdout to
        diagnose.
    *   The `CommitAssertion` adds one provider round-trip per Story
        per wave — negligible against the wave duration but real
        against a 100-Story epic; the gating is not configurable
        (intentionally — silent zero-delta closes are always wrong).
    *   The Epic #413 retro itself is the proof: while writing this
        ADR, the runner correctly identified a no-spawn condition
        for Wave N would not have surfaced under the prior protocol.

## ADR-20260422: `sprint-story-close` recovery via explicit --resume / --restart

*   **Status:** Accepted (Epic #413 Story #421, v5.15.2).
*   **Context:** Epic #380's mid-close on Story #389 required ~30
    minutes of manual git surgery (resolve the merge in progress,
    re-run validation, re-merge to the Epic branch). The stock
    `story-close.js` had no concept of "resuming" — re-running
    it from the worktree always re-ran init/implement/validate
    end-to-end, which was wasteful and racy.
*   **Decision:** `story-close.js` now classifies the close-time
    state via `detectPriorState()` into one of: `clean` (default,
    proceed), `unmerged-story-branch` (story branch has commits ahead
    of `epic/<id>` that haven't merged), `merge-in-progress` (UU
    markers on `epic/<id>`), or `dirty-worktree` (uncommitted edits in
    `.worktrees/story-<id>/`). With no flag, the script prints the
    detected state + remediation guidance and exits.
    `--resume` picks up at the merge resolution step without
    re-running init/implement/validate. `--restart` aborts any partial
    state and re-inits from scratch.
*   **Alternatives considered:**
    *   Always re-init (the prior behaviour) — rejected; throws away
        in-flight work and risks loss of uncommitted changes in the
        worktree.
    *   Detect the state and silently auto-resume — rejected; the
        operator should explicitly choose recovery vs restart so an
        accidental partial state isn't promoted to "shipped" without
        review.
*   **Consequences:**
    *   The recovery path Epic #380 needed to execute manually for
        Story #389 reduces to `sprint-story-close --story 389 --resume`.
    *   The default (no-flag) failure is loud and informative rather
        than silent — operators see what state the close is in before
        they choose their next action.
    *   Memory feedback entry `feedback_sprint_story_close_reap.md`
        gains a worked recovery example tied to the new flags.

## ADR-20260422-441a: Force-reap worktrees whose Story branch is already merged

*   **Status:** Accepted (Epic #441 Story #451, v5.15.3).
*   **Context:** Epic #413's `/sprint-close` Phase 4 reaper left 3 of 6
    worktrees orphaned (`story-420`, `story-423`, `story-424`) with
    `reap-skipped: uncommitted-changes`, even though every Story branch
    had already merged into `epic/413`. The "uncommitted" content was
    biome-format drift and already-merged agent edits — safe to
    discard, but the reaper's conservative default preserved them and
    required manual `rmdir` + `git worktree prune` + `git branch -D`.
*   **Decision:** When `git merge-base --is-ancestor` confirms the
    Story branch is already part of `epic/<id>`, Phase 4 force-reaps
    the worktree by default (`git worktree remove --force` + prune +
    `branch -D`). The destructive step is bounded to "already-merged"
    state, so the only content at risk is post-merge drift. A
    `--no-reap-discard-after-merge` flag restores the prior
    conservative behavior. Force-reap emits a `friction` structured
    comment naming the Story and listing the discarded paths so the
    signal isn't lost.
*   **Alternatives considered:**
    *   Move the assertion check before the reaper (so the reap runs
        against the still-unmerged branch) — rejected; it conflates
        merge state with reap state and does not solve the "Windows
        worktree is EBUSY because a process holds a file handle" case.
    *   Require every close to commit format drift onto the Story
        branch before merging — rejected; increases pre-merge noise
        without changing the post-merge "discard is safe" property.
*   **Consequences:**
    *   Memory feedback entry `feedback_sprint_story_close_reap.md`
        becomes obsolete for the `already-merged` case; it remains
        relevant only for truly-in-progress worktrees, which is now
        the exclusive domain of the `--no-` override.
    *   Operators who intentionally leave work-in-progress in a
        worktree after close must pass the override explicitly.

## ADR-20260422-441b: Canonical structured-comment writer is the MCP tool

*   **Status:** Accepted (Epic #441 Story #449, v5.15.3).
*   **Context:** The MCP tool
    `mcp__agent-protocols__post_structured_comment` originally
    accepted only `progress | friction | notification` as `type`
    values. As a result, `epic-code-review.js`,
    `.claude/skills/epic-retro.md`, the wave-observer, and the
    progress-reporter each hand-rolled their own structured-comment
    marker and posted via `provider.postComment` directly, bypassing
    payload-schema validation. During Epic #413's close, the retro
    flow had to fall back to `notification` type as a workaround.
*   **Decision:** The MCP tool's `type` enum + payload schema are
    extended with `code-review`, `retro`, `retro-partial`,
    `epic-run-state`, `epic-run-progress`, `parked-follow-ons`,
    `dispatch-manifest`, and a regex for parametric `wave-N-start` /
    `wave-N-end`. All consumers that previously hand-rolled markers
    route through the tool. Hand-rolled `provider.postComment` calls
    with structured markers are treated as an anti-pattern.
*   **Alternatives considered:**
    *   Leave the enum as-is and continue hand-rolling — rejected;
        duplicates the marker invariants across multiple call sites
        and loses schema validation.
    *   Accept arbitrary `type` strings — rejected; loses the
        validation surface that catches typo-driven markers.
*   **Consequences:**
    *   A single canonical writer enforces marker shape + payload
        validation. The retro-fallback-to-`notification` regression is
        no longer possible.
    *   New structured-comment types are a schema bump, not a
        convention change — future additions land alongside their
        validators.

## ADR-20260423: Trust the ticket, not the pipe — idle-timeout ground truth

*   **Status:** Accepted (Epic #470, v5.17.0).
*   **Context:** `epic-runner` spawns each Story as
    `claude -p '/sprint-execute <id>' --dangerously-skip-permissions`.
    The `-p` flag runs the CLI in batch mode: the model's final response
    is the only stdout the pipe ever sees, emitted at session exit.
    For architect-tier stories that legitimately take >15 minutes of model
    + tool time, the pipe stays silent the whole run. The idle-watchdog
    was therefore firing on real work, not hangs, and declaring the
    Story `failed` even when the sub-agent went on to merge and close
    the ticket cleanly. Compounding the problem on Windows, the
    `shell: true` spawn meant `proc.kill()` terminated `cmd.exe` only,
    orphaning the grandchild `node` running Claude Code; the orphan
    often finished the work after the runner had reported failure.
*   **Decision:** The idle-timeout path is no longer authoritative.
    When the watchdog fires, the runner (A) calls `killProcessTree(proc)`
    — on Windows `taskkill /T /F /PID` to reap the whole tree, elsewhere
    `proc.kill()` — then (B) polls the Story ticket every 15s for up to
    120s via `provider.getTicket(id, { fresh: true })`. If a grace read
    finds `agent::done`, resolve `done`; `agent::blocked` resolves
    `blocked`; otherwise the runner finally reports `failed` with the
    actual label list in the detail string.
*   **Alternatives considered:**
    *   Raise `idleTimeoutSec` globally — papers over the mismatch; long
        stories just fail a few minutes later. Rejected.
    *   Force `claude -p` to stream token output — not a supported CLI
        flag. Rejected.
    *   Switch to a tier-aware timeout — architect stories get 30m,
        engineer stories 15m. Adds config surface without fixing the
        Windows orphan. Folded into (A)+(B) as future tuning.
*   **Consequences:**
    *   False-positive `failed` halts on long Stories stop happening —
        the runner reports the ticket's actual state.
    *   Windows grandchild orphans no longer survive `proc.kill()`.
    *   Friction-comment detail now reads
        `idle-timeout: no output for 900s; labels=<actual labels>`
        instead of speculating "likely hung on interactive prompt".
    *   Resumed runs short-circuit already-done Stories in `iterate-waves`
        via a pre-launch label fetch, so a blocker halt no longer costs
        a fresh worktree + `npm ci` for every closed Story on re-run.

---

## ADR-20260423-511a: Features remain in the cascade; Epics and Planning do not

*   **Status:** Accepted
*   **Date:** 2026-04-23
*   **Epic:** #511
*   **Context:** `cascadeCompletion()` previously excluded only `type::epic`,
    `context::prd`, and `context::tech-spec` parents. Features fell through
    the exclusion list silently — they auto-closed because nothing stopped
    them, not because the behaviour had been chosen. A Feature still being
    scoped while early Stories landed closed prematurely, stranding later
    scope work without a parent.
*   **Decision:** Keep Feature auto-close, and make it an explicit choice
    rather than an implicit side-effect. A Feature carries no standalone
    branch, no merge step, and no release artefacts — when its last child
    Story closes, the Feature is complete by definition, and a manual close
    step would be pure ceremony. Operators who want Feature-level
    acceptance-criteria verification should encode it in the final child
    Story. The exclusion list in `cascadeCompletion()` is now asserted by a
    regression test pinned under Epic #511 so future refactors cannot drift.
*   **Alternatives considered:**
    *   Add `type::feature` to the exclusion list — forces a manual close
        step with no corresponding merge/release work. Rejected as
        ceremony.
    *   Scope-guard Features via a new `feature::scoping-complete` label —
        adds surface area to solve a problem the Story-level workflow
        already owns.
*   **Consequences:**
    *   Feature cascade behaviour is load-bearing, not accidental.
    *   A future refactor that accidentally adds `type::feature` to the
        exclusion list fails the pinned test rather than silently changing
        closure semantics.
    *   The Feature auto-close rule is now documented in
        [`architecture.md` § Cascade Behavior](architecture.md#cascade-behavior).

---

## ADR-20260423-511b: `transitionTicketState.fromState` lookup keeps its swallow, now with a debug log

*   **Status:** Accepted
*   **Date:** 2026-04-23
*   **Epic:** #511
*   **Context:** `transitionTicketState()` wraps the prior-state label
    lookup in a silent try/catch — any error leaves `fromState` as `null`
    and downstream notifier payloads ship `{ fromState: null, toState: … }`.
    The review under Epic #511 asked: deliberate or accidental?
*   **Decision:** Deliberate — keep swallowing. A transient network flake
    reading the prior label must not block a legitimate state transition;
    the transition itself is the authoritative event. Add a `debug`-level
    log so the operator can correlate a null `fromState` with the
    underlying error, and document `null` as a valid value in the notifier
    payload contract.
*   **Consequences:**
    *   Transitions remain resilient to read flakes.
    *   Consumers that branch on `fromState` must handle `null`
        explicitly (existing contract now documented).
    *   Silent failures are observable at `debug` log level.

---

## ADR-20260423-511c: Dispatch-manifest writes are atomic (tmp + rename)

*   **Status:** Accepted
*   **Date:** 2026-04-23
*   **Epic:** #511
*   **Context:** `.agents/scripts/lib/presentation/manifest-persistence.js`
    wrote the dispatch manifest directly. A crash mid-write (or a full
    disk) left the file truncated; the next orchestrator run consumed a
    corrupt JSON file as if it were the source of truth.
*   **Decision:** Write to `temp/dispatch-manifest-<epicId>.json.tmp`, then
    `fs.renameSync()` to the final path. `rename` is atomic on the same
    filesystem — the final path either carries the previous valid manifest
    or the newly-written one, never a partial write. If `rename` fails,
    delete the `.tmp` residue and re-throw. Surface the persist outcome to
    the MCP caller via `manifestPersisted: boolean` and optional
    `manifestPersistError: string` on the `dispatch_wave` tool result —
    callers (notably `sprint-execute`) already treat the manifest as
    canonical, so a failed persist must not be swallowed.
*   **Consequences:**
    *   A mid-write crash never corrupts the manifest.
    *   MCP callers can branch on `manifestPersisted` instead of reading a
        stale file unknowingly.
    *   Regression test covers the write-failure path (`fs.writeFileSync`
        throws `EACCES`, assert `manifestPersisted: false` + error string).

---

## ADR-20260424-553a: Bounded-concurrency + TTL cache for epic-runner fanout

*   **Status:** Accepted
*   **Date:** 2026-04-24
*   **Epic:** #553
*   **Context:** Two independent performance audits converged on the same
    hot paths. `wave-gate.js` ran three serial `for..of` loops of
    `await getTicket`; `ProgressReporter` fanned out `getTicket(id, { fresh: true })`
    across every story in every wave on every cadence tick; `state-poller`
    fetched a full ticket per tracked story just to read `.labels`; every
    `GitHubProvider` construction spawned `gh auth token` afresh. On large
    epics this produced avoidable wall-clock and risked secondary rate
    limits. Unbounded `Promise.all` would trade sequential latency for a
    thundering-herd problem.
*   **Decision:** Introduce a single `concurrentMap(items, fn, { concurrency })`
    primitive at `lib/util/concurrent-map.js` and adopt it at every
    framework fanout: wave-gate (all stories), commit-assertion at wave-end
    (cap 4; git is CPU/disk-bound), progress-reporter (cap 8). Extend the
    provider cache with `getTicket(id, { maxAgeMs })`; swap the
    progress-reporter's `{ fresh: true }` for `{ maxAgeMs: 10_000 }`. Prime
    the ticket cache from every `getTickets(epicId)` sweep so downstream
    per-ticket reads cost zero HTTP. Memoize the first successful
    `gh auth token` into `process.env.GITHUB_TOKEN` so subsequent provider
    constructions short-circuit. Add a bulk `issues?labels=agent::*&state=open`
    path to `state-poller` with malformed-response fallback to per-ticket.
*   **Consequences:**
    *   10-second TTL staleness is the ceiling on label-observation
        lag. Any write through the provider invalidates the cache
        entry, so post-write reads are fresh.
    *   Concurrency caps are currently constants; an `agentSettings`
        override is deferred until the phase-timer data (same Epic)
        demonstrates where the caps actually bind.
    *   Bulk-poll is guarded by an explicit well-formedness check;
        label-schema drift falls back to the per-ticket path rather
        than propagating bad state.
    *   Phase-timer instrumentation (ADR-20260424-553b) is the
        measurement surface that validates these caps on future epics —
        no more guessing.

---

## ADR-20260424-553b: Per-phase timing as a first-class epic-runner surface

*   **Status:** Accepted
*   **Date:** 2026-04-24
*   **Epic:** #553
*   **Context:** Consumers could not distinguish framework-intrinsic
    overhead (worktree create, `.agents/` copy, bootstrap) from their own
    costs (install, lint, test, implement) when a story took too long.
    Progress snapshots reported wave-level state but carried no timing
    data, so perf regressions were caught by anecdote rather than
    measurement. Future perf work had no baseline to measure against.
*   **Decision:** Build `lib/util/phase-timer.js` + `phase-timer-state.js`
    as a framework primitive with `snapshot` / `restore` semantics so
    phase spans survive the `sprint-story-init` → `sprint-story-close`
    boundary. Emit per-phase elapsed-time lines during the lifecycle.
    On Story close, post a `phase-timings` structured comment on the
    Story ticket. Extend `ProgressReporter` to aggregate **median /
    p95** across every closed Story in the current wave and render the
    result into the Epic's `epic-run-progress` comment.
*   **Consequences:**
    *   Per-Story timings become the regression canary for future
        framework-overhead changes — the next perf Epic starts with
        data, not inference.
    *   The `phase-timings` comment is machine-readable so consumer
        projects can build their own dashboards without scraping logs.
    *   The `ProgressReporter` aggregation runs behind the same TTL +
        concurrency cap introduced in ADR-20260424-553a — observability
        cannot re-introduce the fanout cost it was designed to measure.

## ADR-20260424-596a: CRAP as a sibling gate, not a replacement for MI

*   **Status:** Accepted
*   **Date:** 2026-04-24
*   **Epic:** #596
*   **Context:** The maintainability (MI) gate ratchets a per-file composite
    score, but is coverage-blind: a 30-branch function scores identically
    whether it has 0% or 100% test coverage. MI tells operators *what to
    refactor*; it does not tell them *what to test next*. Per-method
    cyclomatic complexity (from `typhonjs-escomplex`) and per-method coverage
    (from the `c8` artifact) were already present in CI but unused for risk
    signalling. Folding the new model into the MI baseline envelope would
    have churned every existing consumer baseline and conflated two distinct
    questions (file-level refactor priority vs. method-level test priority)
    onto one ratchet.
*   **Decision:** Ship CRAP as a **sibling pipeline** with its own baseline
    artefact (`crap-baseline.json`), CLIs (`check-crap`, `update-crap-
    baseline`), and config block (`agentSettings.maintainability.crap`).
    Wire it at the same three sites as MI (close-validation, ci.yml, pre-
    push) but enforce a **hybrid** model: tracked methods ratchet with line-
    drift fallback; new methods must score ≤ `newMethodCeiling` (default 30,
    the canonical CRAP threshold). Removed methods are surfaced as a counter,
    never a failure. Both gates share an envelope shape
    (`{ kernelVersion, summary, violations }`) so agent workflows can consume
    both with one parser.
*   **Consequences:**
    *   Existing `maintainability-baseline.json` stays valid — no consumer
        repo gets a free baseline reshuffle on adoption.
    *   The two questions separate cleanly: MI = "where is the rot?", CRAP
        = "where is the untested complexity?".
    *   A future Epic can refactor both gates onto a shared envelope/helper
        base if/when symmetry pays off; today's parity is shape-level only.

## ADR-20260424-596b: Base-branch-enforced anti-gaming guardrail

*   **Status:** Accepted
*   **Date:** 2026-04-24
*   **Epic:** #596
*   **Context:** A PR that simultaneously raises `newMethodCeiling` in
    `.agentrc.json` AND introduces a method over the new (relaxed) ceiling
    would pass its own gate — the gate reads its own branch's config. With
    agentic authorship, this is not a hypothetical: the shortest path to
    green CI is to relax the threshold. A purely advisory "don't do this"
    norm would be eroded within weeks.
*   **Decision:** Add a `pull_request`-only `baseline-refresh-guardrail.yml`
    workflow that reads thresholds from the **base branch** via
    `git show origin/<base>:.agentrc.json`, then re-runs `check-crap` with
    those values forced via `CRAP_NEW_METHOD_CEILING` / `CRAP_TOLERANCE` /
    `CRAP_REFRESH_TAG` env vars. Any PR that touches `crap-baseline.json` or
    `maintainability-baseline.json` must include at least one commit whose
    subject starts with the configured `refreshTag` (default
    `baseline-refresh:`) AND whose body is non-empty — both required.
    Baseline-only PRs receive the `review::baseline-refresh` label
    idempotently across re-runs.
*   **Consequences:**
    *   Threshold relaxation requires either a separately committed baseline
        refresh (with justification body) or it fails CI under base-branch
        values — a malicious or careless PR cannot do both at once.
    *   The label ensures every refresh is reviewer-visible even on green
        CI; "silently merged a baseline" is no longer a possible failure
        mode.
    *   The env-var seam is the same one operators can use ad-hoc to test
        a stricter ceiling against the current branch — testing surface is
        identical to the enforcement surface.

## ADR-20260424-596c: Kernel-version stamp on the CRAP baseline

*   **Status:** Accepted
*   **Date:** 2026-04-24
*   **Epic:** #596
*   **Context:** `typhonjs-escomplex` makes scoring decisions that change
    between minor versions. Without a version stamp, an upstream dependency
    bump silently rescores every method, producing a ghost baseline that
    looks healthy but compares against numbers no one ran. Worse, an
    "everything passes" run after a bump masks real regressions in the
    delta. Consumer repos pulling the framework as a submodule absorb the
    bump without warning.
*   **Decision:** Stamp `crap-baseline.json` with two version fields:
    `kernelVersion` (the inline CRAP formula's contract) and
    `escomplexVersion` (the dep). On any mismatch with the running scorer,
    `check-crap` exits 1 with `[CRAP] scorer changed from X to Y — run 'npm
    run crap:update'`. The bootstrap path (no baseline at all) still exits 0
    with a different message — first-run on a consumer repo must never hard-
    fail.
*   **Consequences:**
    *   Dependency bumps surface explicitly with a clear remediation, not
        as a quiet rescore.
    *   Bootstrap and version-mismatch are distinct exit codes (0 vs 1)
        and distinct messages — operators do not have to diff stdout to
        tell a fresh repo from a dependency drift.
    *   The `kernelVersion` field gives us a future-proof seam for
        in-formula changes (e.g., switching from `(1−cov)³` to `(1−cov)²`)
        without a destructive force-rescore on every consumer.

---

## ADR-20260424-638a: `story-566` reap recovery is a self-inflicted dirty-tree bug

*   **Status:** Accepted
*   **Date:** 2026-04-24
*   **Epic:** #638 (Story #648)
*   **Context:** Epic #553 close fired the `worktree.reap recovered via
    fs-rm-retry … attempts=1 lockReason=contains modified or untracked
    files` warning on `story-566`. The log is shaped for Windows-lock
    recovery, but `attempts=1` and the stderr quoted `git worktree
    remove`'s *own* uncommitted-files guard — not a lock class error.
    Classification required tracing the full reap path on a framework
    checkout (where `.agents/` is a tracked directory, not a submodule).
*   **Root cause:** `removeCopiedAgents()` in
    `.agents/scripts/lib/worktree/bootstrapper.js` unconditionally
    `fs.rmSync`'s `<wtPath>/.agents` before `git worktree remove` runs.
    The three follow-up index operations self-guard on
    `isAgentsSubmodule(repoRoot)` and no-op in framework repos, but the
    physical delete does not. In the framework repo the deletion wipes a
    tracked directory, producing a deliberate dirty state that `git
    worktree remove`'s pre-check flags with "contains modified or
    untracked files, use --force to delete it". The belt-and-braces
    `fs.rm` then removes the whole worktree, so the reap ultimately
    succeeds — but the warn log misattributes the cause to a Windows
    lock, and every framework-repo story close pays the retry cycle.
*   **Why the existing coverage missed it:**
    `tests/lib/worktree-manager.test.js` line 1419 — *"skips index
    scrub in non-submodule (framework) repos"* — creates `wtPath` but
    never materialises `wtPath/.agents`, so `fs.lstatSync` throws and
    the `fs.rmSync` branch is never exercised. Real framework worktrees
    always have a checked-out `.agents/` directory.
*   **Decision:** Classify as a **recoverable bug (outcome b)**. Guard
    the `fs.rmSync`/`fs.unlinkSync` in `removeCopiedAgents` with
    `isAgentsSubmodule(repoRoot)`, matching the self-guard already
    present on the three index-scrub follow-ups. Keep the
    `removeWorktreeWithRecovery` fs-rm fallback in place as
    belt-and-braces for genuine Windows locks. Add a regression test
    asserting that a materialised `.agents/` survives
    `removeCopiedAgents` in a non-submodule repo.
*   **Consequences:**
    *   Framework-repo story closes stop paying the retry cycle and
        stop emitting misleading `fs-rm-retry` warnings on every close.
    *   `git worktree remove` now succeeds on its first attempt in the
        common framework path; Stage 1 recovery resumes being a
        real-failure signal instead of a self-inflicted one.
    *   Submodule-consumer repos are unaffected: `isAgentsSubmodule`
        returns true, the physical delete still runs, and the index
        scrub + modules purge continue as before.
    *   The retained fs-rm fallback still covers the true Windows-lock
        case it was designed for.

## ADR-20260426-817a: Validation evidence is keyed by commit SHA, not by build ID

*   **Status:** Accepted (Epic #817, v5.28.0).
*   **Context:** Epic #817's hot-path audit found lint and tests running
    five-plus times per Story against the same tree (sprint-execute Step 2,
    story-close, sprint-code-review, sprint-close Phase 4, pre-push, CI).
    The dominant local cost was repeat work, not new work, and the
    duplicate runs were the largest source of agents chasing the same
    failure across phases. We needed a skip mechanism that did not let a
    stale pass paper over a fresh regression.
*   **Decision:** Each successful gate (lint, test, biome format, MI, CRAP)
    writes `{ gateName, commitSha, commandConfigHash, timestamp, exitCode }`
    to `temp/validation-evidence-<scopeId>.json`. A subsequent caller skips
    the gate **only** when the current `git rev-parse HEAD` matches the
    recorded `commitSha` AND the resolved command-config hash matches.
    Anything else — dirty tree, new commit, config change, missing
    evidence file — runs the gate. `--no-evidence` is the explicit override
    for iterating on a flaky test.
*   **Consequences:**
    *   Repeat phases against an unchanged tree skip in milliseconds.
    *   False-green risk stays bounded: any working-tree change at the
        commit-SHA granularity invalidates the evidence; config drift
        invalidates it via the command-config hash.
    *   Evidence is `temp/`-local and gitignored, so the skip is per-clone
        — CI gets its own evidence record (or none), and pre-push hooks
        retain authoritative independence.

## ADR-20260426-817b: `sprint-story-close` is the canonical local Story validation gate

*   **Status:** Accepted (Epic #817, v5.28.0).
*   **Context:** `sprint-execute.md` Step 2 used to require an explicit
    `npm run lint && npm test` before invoking `story-close.js`,
    which then re-ran the same gates as part of close-validation. Headless
    sub-agent runs paid the cost twice; interactive runs blurred the
    decision of which result was authoritative. With evidence-aware skip
    in place (#817a), the duplication was no longer needed for safety.
*   **Decision:** `story-close.js` is the single source of truth
    for local Story merge readiness. The pre-flight `npm run lint &&
    npm test` is now described as advisory `--fast` mode for interactive
    iteration — failures will be re-surfaced by the close-validation gate
    regardless. Sub-agent runs may proceed straight from implementation
    to close.
*   **Consequences:**
    *   Per-Story wall-clock cost roughly halves on sub-agent runs.
    *   Operator authority is unambiguous: the close gate's verdict is
        the verdict.
    *   Interactive `--fast` mode remains useful in terminals where the
        operator wants a fast read on a fix before composing the close.

## ADR-20260426-817c: Soft-failing gates surface degraded state explicitly, not silently

*   **Status:** Accepted (Epic #817, v5.28.0).
*   **Context:** `select-audits.js` (diff timeout fallback to keyword-only),
    `lint-baseline.js` (zero-error fallback on JSON parse failure), and
    `baseline-refresh-guardrail.js` (empty-changed-files on `git diff`
    failure) all returned permissive zero-error envelopes when their
    inputs failed. The audit found this fail-open behaviour produced
    silent green runs that read identically to genuine clean runs.
*   **Decision:** Each soft-failing gate either fails closed under
    `--gate-mode` (or `AGENT_PROTOCOLS_GATE_MODE=1`) — non-zero exit, no
    permissive output — or returns a structured `{ ok: false, degraded:
    true, reason, detail }` envelope on stdout with a non-zero exit code.
    The caller decides how to interpret. The mute fail-open path is gone.
*   **Consequences:**
    *   Operators can no longer mistake a degraded run for a clean one.
    *   CI / pre-push integrations that previously absorbed the silent
        green now see explicit degraded output and may need a one-line
        adjustment to their handling.
    *   The structured envelope shape is consistent across all three
        gates so a single helper detects degradation.

## ADR-20260426-817d: CLI entrypoints carry `node:coverage ignore file`; their `main()` is exercised via integration tests, not unit-line coverage

*   **Status:** Accepted (Epic #817 follow-on, v5.28.1).
*   **Context:** Story #816's long-tail CRAP cleanup attempted to score
    `run-audit-suite.js::main`, only to find the file was silently dropped
    from the CRAP scan because its first comment line is
    `/* node:coverage ignore file */`. Twenty-one other CLI entrypoints
    under `.agents/scripts/*.js` carry the same directive, including
    `epic-runner.js`, `story-close.js`, `story-init.js`,
    `epic-planner.js`, `dispatcher.js`, `epic-plan-spec.js`,
    `epic-plan-decompose.js`, `notify.js`, `health-monitor.js`,
    `post-structured-comment.js`, `pool-claim.js`, `remote-bootstrap.js`,
    `select-audits.js`, `ticket-decomposer.js`, `agents-bootstrap-github.js`,
    `assert-branch.js`, `context-hydrator.js`, `diagnose-friction.js`,
    `hydrate-context.js`, `epic-plan.js`, and `epic-plan-healthcheck.js`.
    The convention pre-dates this Epic but had never been written down,
    making it ambiguous whether the directive on a given file was a
    deliberate convention or an accidental escape hatch.
*   **Decision:** The `node:coverage ignore file` directive is the
    canonical convention for **CLI entrypoint scripts** under
    `.agents/scripts/`. An entrypoint's `main()` orchestrates pure helpers
    that are themselves unit-tested; the orchestrator is exercised
    end-to-end via the framework's integration suite (story-init/close
    happy paths, dispatcher fan-out, manifest generation, friction
    posting) and via the `tests/*-cli.test.js` suites that drive each CLI
    via `runAsCli` with stubbed I/O. We do not chase per-line coverage on
    `main()` itself because (a) its branches are flag-parsing and exit
    code routing whose value at the line level is dwarfed by the helper
    behaviour the integration tests already cover, and (b) running the
    CLI under coverage costs wall-clock time the helper-level tests buy
    cheaper.
*   **Scope of the convention:**
    *   The directive applies to **CLI entrypoints only** — files at the
        top of `.agents/scripts/` that ship a `runAsCli(import.meta.url,
        main, ...)` invocation or are the documented `node ...` target
        of a workflow phase.
    *   It does **not** apply to library files under
        `.agents/scripts/lib/`. Library code remains fully covered.
    *   It does **not** waive the obligation to ratchet helpers exercised
        by the entrypoint. The "extract pure helpers + add tests" pattern
        from Story #792 / #816 still applies — pull complex branching
        out of `main()` into testable helpers in either the same file
        (`export function ...`) or a sibling module under `lib/`.
*   **Consequences:**
    *   The CRAP gate's silent drop of these 22 files is intentional and
        documented; future audits can stop flagging it as a gap.
    *   New CLI entrypoints follow the same convention. If a new
        entrypoint does **not** carry the directive, that is a deliberate
        choice — typically because the file is small enough to remain
        fully testable as a single unit — and should be called out in
        the PR description.
    *   The convention is reviewed if a regression slips past the helper
        tests but would have been caught by main-level coverage. None
        observed to date.

## ADR-20260502-960a: Production code is not shaped by test internals — tests import helpers directly with an explicit `ctx` bag

*   **Status:** Accepted (Epic #946, Stories C1+C2 → #960).
*   **Context:** `WorktreeManager` historically grew a "Backwards-compat
    delegates for tests that probe private helpers" block — five
    `_`-prefixed methods (`_copyBootstrapFiles`, `_provisionWorkspace`,
    `_copyAgentsFromRoot`, `_removeCopiedAgents`, `_isAgentsSubmodule`)
    that existed solely so the pre-split `tests/lib/worktree-manager.test.js`
    suite could keep calling instance methods after the implementation
    was decomposed into `lib/worktree/bootstrapper.js` and
    `lib/workspace-provisioner.js`. The delegates added no behaviour;
    they were a compatibility shim for the test file. Production
    callers (the lifecycle layer) had already migrated to the helper
    modules and passed an explicit `ctx` bag, so the delegates were
    dead weight on the production code path while the test file
    continued to pretend the manager owned the logic.
*   **Decision:** Production modules do not carry test-shaped surfaces.
    When a class's internal helpers are extracted into pure functions
    that take a `ctx` bag, the corresponding tests **migrate to the
    helper module directly** rather than the class re-exposing the
    helper as a private method. The migration pattern is "test imports
    the helper directly, constructs a `ctx` bag with the fields the
    helper documents, and asserts on the helper's return value or its
    side-effects." The class loses the underscore-prefixed delegate.
    Stories C1+C2 of Epic #946 codified this for the worktree split:
    `tests/lib/worktree-manager.test.js` now calls
    `provision({ sourceRoot, targetWorktree, files, logger })` from
    `workspace-provisioner.js` and
    `copyAgentsFromRoot(ctx, wtPath)` /
    `removeCopiedAgents(ctx, wtPath)` /
    `isAgentsSubmodule(repoRoot)` from `worktree/bootstrapper.js`
    instead of the deleted `wm._*` delegates.
*   **Consequences:**
    *   `WorktreeManager` shrinks: the ~70-line backwards-compat block
        in `lib/worktree-manager.js` is gone, leaving only the public
        lifecycle facade (`ensure`, `reap`, `gc`, `prune`, `list`,
        `pathFor`, `isSafeToRemove`, `sweepStaleLocks`).
    *   Tests for the bootstrap / submodule logic become independent of
        the class's wiring — they exercise the helper contract
        verbatim, so a future split or rename of `WorktreeManager` does
        not invalidate the suite.
    *   New code follows the same rule: a helper extracted "for
        testability" is tested at the helper boundary, not via a
        manager-level passthrough. Reviewers reject `_`-prefixed
        delegates whose only call site is a test file.
    *   The ctx bag fields each helper expects are documented in the
        helper's JSDoc; tests construct bags inline rather than
        reaching through a partially-constructed class instance to
        mutate them (the old `wm._isAgentsSubmodule = () => true`
        pattern is replaced by `ctx.isAgentsSubmodule: () => true`).
