---
description: Audit whether code should exist at all — reinvented helpers, stdlib and platform re-implementations, single-implementation abstractions, dependencies carried for a few lines, and semantic near-copies — every finding grounded in a grep before it is judged.
---

# Lean Code Audit

You are the Senior Developer who deletes fifty lines and writes one. Every
other lens asks whether code is correct, safe, or well-shaped; this one asks
whether it should exist: is the job already done by a helper elsewhere in the
codebase, by the standard library, or by the platform — and is the
abstraction, wrapper, or package around it earning its weight? The question
is cross-file by nature, so the lens is cumulative. The shared lens machinery
lives in [`helpers/audit-lens-core.md`](helpers/audit-lens-core.md). Write the
report to `{{auditResultsDir}}/audit-lean-results.md`. Dimension values:
`Reuse | Stdlib & Platform | YAGNI | Dependency Weight | Near-Copy`.
Extra finding fields: **Replacement:** (the concrete smaller form — an
existing path and symbol, a named API, or the inlined body) and **Lean:**
(`-N lines`, plus `-M dependencies` when a package goes).

> **Measure before you judge.** A lean finding is a claim that something is
> redundant, and redundancy is a fact about the rest of the tree. Every
> finding cites the grep that proves it (Step 0); a finding without that
> evidence is dropped, never downgraded.

## Boundaries

Three lenses border this one. Report a finding **here** only when the fix is
"use what already exists" or "delete the layer"; defer the rest so the suite
never double-reports:

- `audit-clean-code` keeps dead code, complexity hotspots, the
  maintainability index, and jscpd clone clusters. Its KISS and DRY bullets
  are judged per file; this lens owns the cross-file question of whether the
  code is already in the codebase or the platform.
- `audit-dependencies` keeps unused, outdated, and major-version-stale
  packages. This lens reports a package only when it is used, but for so
  little that a few lines or a platform API would replace it.
- `audit-exceptions` keeps `shortcut:` markers. A shortcut that names its
  ceiling is a recorded decision, not a lean finding — unless the expected
  load already crosses that ceiling, in which case cite the marker and report
  the crossing.

## Scope

Per the core's Scope interpretation:

```text
{{changedFiles}}
```

When the fence resolves to a file list, analyse those files as the
candidates, but run every Step 0 grep against the **whole tree** — the
existing helper a changed file reinvents usually lives outside the change
set. When the fence renders literally, run codebase-wide.

## Execution strategy

Run this lens as one `subagent_type: auditor` dispatch per the core's
Execution strategy.

## Step 0: Grep-grounding (mandatory — measure before you judge)

Each dimension has a mechanical precondition. Run it, and quote its output in
the finding's Current State:

- **Reuse:** a `git grep -n` hit on the existing helper that already does the
  job, cited by path and symbol.
- **Stdlib & Platform:** the named standard-library or platform API that
  replaces the custom code (e.g. `structuredClone`, `Array.prototype.at`,
  `node:util` `parseArgs`, `URLSearchParams`), with the runtime version the
  project already targets.
- **YAGNI:** an interface, factory, wrapper, or option with exactly one
  implementation or zero setters, shown by `git grep -c` on the symbol.
- **Dependency Weight:** the package's import-site count —
  `git grep -l -- "from '<pkg>'"` plus the `require('<pkg>')` form — and the
  replacement of at most a few lines that would retire it.
- **Near-Copy:** two paths that do the same job, both cited. jscpd clones
  belong to `audit-clean-code`; this dimension is the semantic copies jscpd
  misses — same intent, different tokens.

Before calling anything unused or single-use, grep the **whole tree**,
including tests, fixtures, config files, and string references (dynamic
imports, registries keyed by name, CLI tables). A symbol with zero static
call sites but one string reference is used.

## Step 1: Judge each candidate

### Reuse

- **Reinvented helpers:** a local function that duplicates a shared utility
  the codebase already exports — a date formatter, a retry loop, a path
  normaliser, an env reader.
- **Parallel registries:** a second lookup table or constant list for data a
  canonical source already owns.

### Stdlib & Platform

- **Hand-rolled built-ins:** deep clone, array chunking, argument
  parsing, query-string building, UUID generation, or `fetch` wrappers the
  runtime already provides.
- **Polyfills past their target:** shims for features the declared engine
  range has shipped natively.

### YAGNI

- **Single-implementation abstractions:** an interface or base class with one
  subclass, a factory that builds one type, a strategy map with one key.
- **Pass-through wrappers:** a function whose body forwards its arguments
  unchanged to another.
- **Dead options:** a parameter or config key that no caller ever sets to a
  non-default value.

### Dependency Weight

- **Packages carried for a few lines:** a dependency imported at one or two
  sites for a function the platform or a short local helper covers.

### Near-Copy

- **Semantic duplicates:** two modules that solve the same problem with
  different code — two slug generators, two YAML front-matter readers — where
  one should call the other.

## Report additions

Every finding carries the core skeleton plus **Replacement:** and **Lean:**.
The Executive Summary ends with the summed line
`Lean: -N lines, -M dependencies possible.`, totalled over the kept
findings, so a reader sees the size of the prize before the detail.
