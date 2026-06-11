# CHANGELOG Style Contract

This rule governs the shape of per-release entries in the project CHANGELOG
(typically `docs/CHANGELOG.md` or `CHANGELOG.md`). It applies whenever a
release entry is authored or edited — most commonly inside Story #N's
docs sweep before `/deliver` opens the release PR.

The contract is **guidance-tier** in v1: no automated gate fails a close when
an entry drifts off-template. It still binds every author.

## Goal

A reader scanning release notes should identify what ships in a release in
under 30 seconds. Breaking changes, config-shape changes, and CLI renames
must be impossible to miss. Internal refactor detail belongs in commit
messages and PR descriptions — not here.

## Per-Release Entry Shape

Every entry starts with a version header line already produced by the
release tooling:

```markdown
## [X.Y.Z] - YYYY-MM-DD
```

Immediately below, the entry MUST have:

1. **A short section header** naming the theme of the release — one line,
   Sentence case, no trailing punctuation.

   ```markdown
   ### Epic-runner throughput & caching pass
   ```

2. **A 1–3 sentence theme paragraph** that tells the reader, in plain
   English, what the release is about and why it matters. No bullets, no
   sub-headers, no code fences.

3. **Bullets of user-visible changes**, grouped by natural topic if the
   release spans more than one theme. Each bullet leads with a bold phrase
   naming the change, followed by a one- or two-sentence explanation.

```markdown
## [5.21.0] - 2026-04-24

### Epic-runner throughput & caching pass

Performance and observability pass across the epic-runner hot paths — wave
gating, commit assertion, progress reporting, and label polling. Caching
and bounded concurrency throughout; new per-phase timing surface.

- **Bounded-concurrency parallelism.** Wave gating, commit assertion, and
  progress reporting now fan out in parallel with a configurable cap.
- **Per-phase timing surface.** Story close posts a structured comment
  with per-phase timings; the Epic progress comment aggregates median
  and p95 across closed stories.
```

## Bullets: What Counts as "User-Visible"

Include:

- New CLI commands, flags, or scripts the operator invokes.
- New or renamed labels, ticket shapes, or workflow phases the operator
  touches.
- New or renamed configuration keys, with the old → new mapping if any.
- New behavioural guarantees (e.g., "retries on transient errors").
- Bug fixes the operator would otherwise trip over.
- Performance changes with a user-observable magnitude.

Exclude:

- Internal refactors with no behavioural delta.
- Test additions, coverage bumps, lint cleanups.
- Module renames or file moves invisible to operators.
- Per-phase implementation details ("now uses a BFS walker").

## Banned Content

The following MUST NOT appear in a release entry:

- **Per-ticket citations.** No `(Epic #553)`, `(resolves #612)`,
  `(Story #645)` in bullet text. The theme paragraph may reference the
  Epic once when the release is scoped to one Epic — that is the only
  allowed citation, and only there.
- **Internal file paths** (`lib/orchestration/epic-runner/commit-assertion.js`,
  `.agents/scripts/story-init.js`). Callers care what changed, not
  where it lives.
- **Internal function, class, or method names** (`finalizeMerge`,
  `WorkspaceProvisioner.verify`, `cascadeCompletion`). Name the behaviour,
  not the symbol — unless the symbol is part of the public API.
- **Test counts** (`47 new tests`, `95% coverage`). Tests are a means, not
  a ship artefact.
- **Module-sizing stats** (`shrinks epic-runner from 840 to 420 LOC`).
- **Implementation mechanics** (`BFS walker`, `Promise.all over parents`,
  `exponential backoff with 3 attempts, 500ms base`) unless the mechanism
  is part of a new public contract.

## Mandatory Prominence

The following categories MUST be called out visibly — typically in **bold**
at the start of a bullet, or in a short dedicated section above the
bullet list:

- **Breaking changes.** A bullet leading with `**Breaking:**` or a
  `### Breaking Changes` sub-section. Include the migration path.
- **Config-shape changes.** Moved, removed, renamed, or newly-required
  config keys. Old key → new key, or removal notice with remediation.
- **CLI renames.** Old command → new command, including whether the old
  name remains as a deprecation alias and for how long.
- **Schema shape changes** on structured comments, manifest files, or
  public API payloads. Readers parsing these surfaces must be told.

If a release ships any of the above, they belong at the top of the bullet
list (or in a dedicated sub-section), not buried mid-list.

## Line-Count Guidance

Soft ceilings, not hard fails:

- **Non-major release** (patch or minor): **≤60 lines**, including
  header, theme paragraph, blank lines, and bullets.
- **Major release**: **≤150 lines**. Major releases span larger surface
  and warrant more prominence.

If an entry exceeds the ceiling, prefer splitting a genuinely multi-theme
release into grouped sub-sections over padding the bullet list. Before
accepting a long entry, ask: which bullets are user-visible, and which
are internal detail that migrated in from the Epic body?

## Worked Example — Before/After

The "before" reflects the style that drove the Epic #553 retro action item:
multi-section entries where each bullet leaked internal function names,
file paths, and implementation mechanics. The "after" applies the contract
above.

### Before (off-contract, ~48 lines)

```markdown
## [5.8.7] - 2026-04-15

### Robust story→epic merge at story close

Parallel wave execution kept producing conflicts — Stories branched
early in a wave landed after peers had merged. `finalizeMerge` now:

1. **Pre-merge rebase in the story worktree** onto
   `origin/<epicBranch>`, shrinking the conflict surface to the
   Story's real delta. Failed rebase is aborted and merge still
   proceeds.
2. **Conflict triage via `mergeFeatureBranch`** — same threshold-based
   triage used at integration time (major ≥3 files or ≥20 markers =
   abort; minor = auto-resolve by accepting Story's version with audit
   log).

### Per-worktree node_modules collapsed into shared store

Per-worktree `npm install` duplicated dependencies across every story
tree and blew out disk on parallel waves. `ensure()` now links each
worktree's `node_modules` to a primed donor tree (junction on Windows)
and `reap()` removes the link before `git worktree remove`.
Auto-detected: if the configured strategy is `symlink`, the link
applies.

### Deliver tail auto-invokes pre-merge gates

`/deliver` auto-invokes the code-review module (Phase 4) and
the retro runner (Phase 5) inline instead of halting to ask the
operator to run them separately. `--skip-code-review` available as
an override.

### Epic Health ticket closed alongside PRD/Tech Spec

Step 8's closure sweep now matches any ticket carrying `type::health`
or a title starting with `📉 Epic Health:`, in addition to
`context::prd` / `context::tech-spec`.

### Stale-lock sweep for shared `.git/` dir

`WorktreeManager.sweepStaleLocks({ maxAgeMs = 30_000 })` removes
well-known lock files (`index.lock`, `HEAD.lock`, `packed-refs.lock`,
`config.lock`, `shallow.lock`) whose mtime exceeds the threshold.
Fresh locks belonging to in-flight ops are skipped. Runs at
`/deliver` start, before worktree GC.
```

Contract violations: five separate `###` sub-sections where one theme
would do; internal function names (`finalizeMerge`, `mergeFeatureBranch`,
`ensure()`, `reap()`, `WorktreeManager.sweepStaleLocks`); implementation
mechanics (`BFS walker` equivalent, exact argument shapes, internal step
numbering like "Step 1.4", "Step 8"); lock-file name list leaks
implementation detail that operators cannot act on.

### After (on-contract, ~18 lines)

```markdown
## [5.8.7] - 2026-04-15

### Parallel-wave merge robustness

Parallel story waves kept tripping over each other at integration time.
This release reduces the conflict surface at story close and stabilises
worktree cleanup.

- **Pre-merge rebase at story close** shrinks the conflict window to
  each story's real delta; conflicts above the triage threshold abort
  and surface to the operator.
- **Shared-store worktrees.** Per-story worktrees link a shared
  `node_modules` store, so parallel waves no longer duplicate installs
  or leave residue that blocks reap.
- **`/deliver` auto-invokes pre-merge gates** (code review, retro)
  inline. `--skip-code-review` is available as an override.
- **Closure sweep covers Epic Health tickets** in addition to PRD and
  Tech Spec tickets.
- **Stale-lock sweep** on the shared `.git/` directory runs at
  `/deliver` start, clearing lock files left behind by interrupted
  operations.
```

What changed: one theme section instead of five; the paragraph gives the
"why" in two sentences; each bullet leads with the user-visible behaviour
and drops internal symbols, file paths, and step numbers; the override
flag (`--skip-code-review`) is kept because it is part of the public CLI
surface; the lock-file list is dropped because operators do not act on
individual lock names.

## When to Deviate

- **Major releases** may warrant multiple `###` sub-sections under a
  single version header when the release genuinely spans multiple themes.
  Keep each sub-section on-contract individually.
- **Security fixes** may include CVE-style detail and remediation steps
  beyond normal bullet shape — those callouts are always on-contract.
- **When in doubt**, cut more aggressively. A reader can always follow
  the Epic link for detail; they cannot un-read bullets that told them
  nothing.
