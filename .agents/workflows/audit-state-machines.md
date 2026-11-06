---
description: >-
  Audit implicit state machines — co-varying flags, status fields with
  dependent sidecar fields, transitions written from many sites, and one
  logical state split across systems — and report only the impossible or
  unhandled combinations the code can actually reach, each with a traced write
  path and a sketch of the explicit form that rules it out.
---

# State Machine Audit

You are a Staff Engineer hunting the states nobody designed. Most code tracks
state in loose variables: a few booleans, a status string with fields that
only make sense in some statuses, a label on a ticket plus a file on disk.
Together those variables form a state machine that exists only by implication,
and it usually admits combinations its authors never meant to allow. This lens
names those machines, proves which bad combinations are reachable, and
sketches the explicit form — a discriminated union, a tagged object with one
guard, or a transition table — that would make them unrepresentable. A
machine's writers rarely sit in one file, so the lens is cumulative.

The shared lens machinery lives in
[`helpers/audit-lens-core.md`](helpers/audit-lens-core.md). Write the report to
`{{auditResultsDir}}/audit-state-machines-results.md`. Dimension values:
`Boolean Soup | Status Sidecar | Scattered Transitions | Unhandled State | Distributed State`.
Extra finding fields: **Variables:** (the co-varying set, `path:line` each),
**Reachable Path:** (the traced write sequence that produces the bad
combination) and **Explicit Form:** (a few lines naming the replacement
shape). The report adds two mandatory sections, **State Inventory** and
**Refactor Sketch** (see Report additions).

> **Prove reachability before you judge.** Every object with two fields is
> technically a state machine. A finding is a claim that a specific bad
> combination can happen, so it carries the write path that produces it; a
> combination you cannot trace is inventoried, never reported.

## Boundaries

Four lenses border this one. Report a finding **here** only when the fix is
"change the shape of the state so the bad combination cannot be written";
defer the rest so the suite never double-reports:

- `audit-resilience` keeps whether a reconcile job's filter covers every state
  a failure can leave. This lens reports the state shape that makes the
  combination possible, and defers when the only gap is the reconciler's
  filter.
- `audit-data-model` keeps database enums, `CHECK` constraints and DB-level
  invariants. This lens reports application-level state, and a DB-backed
  status only when the application writes combinations the schema permits.
- `audit-performance` keeps interleaving and concurrency races (TOCTOU, lost
  updates). This lens reports combinations reachable on a single thread of
  execution, with no interleaving required.
- `audit-clean-code` keeps complexity hotspots, naming and stale feature
  flags. A long if-chain is reported here only when it misses a reachable
  state.

## Scope

Per the core's Scope interpretation:

```text
{{changedFiles}}
```

When the fence resolves to a file list, take the state variables those files
read or write as the candidates, but trace every writer and reader across the
**whole tree** — a machine's other writers usually sit outside the change set.
When the fence renders literally, run codebase-wide.

## Execution strategy

Run this lens as one `subagent_type: auditor` dispatch per the core's
Execution strategy. It never fans out on its own judgment.

## Step 0: Qualifying bar (mandatory)

A candidate is an implicit state machine only when **both** parts hold:

1. **Shape.** Two or more variables change together to encode one logical
   state: a set of booleans, a status value plus fields whose validity depends
   on it, or one logical state held in two systems (labels, files on disk, git
   refs, a database row plus a cache, a lease assignee).
2. **Consequence.** At least one combination of those variables that the code
   does not intend is reachable, or one reachable value is not handled by a
   consumer — shown with a traced path: the entry point, then each write by
   `path:line` in the order it executes, then the bad combination it leaves.

A candidate that clears part 1 but not part 2 is recorded in the State
Inventory with `reachable: no` and produces **no finding**. A combination that
only a test fixture or a hand-edited file can produce is not reachable.

## Step 1: Find candidates (tool-first)

Run the greps, then group hits by the object or module that owns them — a
candidate is a group, not a line. Adapt the patterns to the project's
languages per the core's ecosystem-detection rule:

- Run the candidate greps:

  ```bash
  git grep -nE '\b(is|has|was|did|should)[A-Z][A-Za-z]*\s*[:=]\s*(true|false)\b'
  git grep -nE "\b(status|state|phase|stage|mode|kind)\s*[:=]\s*['\"][A-Za-z_-]+['\"]"
  git grep -nE '\.(status|state|phase|stage)\s*=[^=]'
  git grep -nE 'switch\s*\(\s*[A-Za-z_.]*(status|state|phase|stage|kind)\s*\)'
  ```

- For each status variable, count its writer sites; three or more writers with
  no shared guard is a Scattered Transitions candidate.

## Step 2: Judge each candidate

### Boolean Soup

- **Flags that encode one enum:** booleans that together stand for one state
  (`isLoading` / `isError` / `isDone`, `started` / `finished` / `cancelled`)
  where some true/false product is meaningless yet writable — both
  `isLoading` and `isError` true, or `finished` without `started`.

### Status Sidecar

- **Fields valid only in some statuses:** a status field plus nullable fields
  whose meaning depends on it — an `error` set while status is `ok`, a
  `result` null while status is `done`, a `mergedAt` while status is `open`.
  Report the write that leaves the sidecar stale when the status moves.

### Scattered Transitions

- **Transitions with no single guard:** a state written from many sites, so
  an illegal transition (`done` back to `executing`) or a re-entry that
  repeats a side effect is reachable. Name every writer site and the one
  that skips the check the others make.

### Unhandled State

- **Consumers that miss a value:** a `switch`, if-chain or lookup table over a
  status that omits a reachable value and has no exhaustiveness check, or
  falls through to a silent default that treats the missing value as another.

### Distributed State

- **One state, two stores:** one logical state spread across systems that can
  disagree — two lifecycle labels at once, a lease held after its branch is
  gone, a marker file that outlives the work it marks — with no reconciler,
  or with a reconciler that cannot see the disagreeing combination (then
  name the combination and defer the filter to `audit-resilience`).

## Step 3: Evidence and severity

- **Second read of the write order.** Every finding's Reachable Path is
  re-checked by a second read of the actual write order — the call sequence,
  the early returns, the guards upstream — not of a comment, a type
  annotation, or one file. A path an upstream guard actually blocks is
  dropped and counted in the kept/dropped line.
- **Severity calibration.** Grade on the core scale with these anchors:
  - `Critical` or `High` — the reachable state loses or corrupts data, repeats
    an external side effect (a double charge, a double merge, a double post),
    or wedges a lifecycle with no recovery path.
  - `Medium` — a wrong user-visible result, or a stuck state that a retry or
    an operator clears.
  - `Low` — a reachable but cosmetic mismatch.

## Report additions

Beyond the core's shared skeleton, this lens adds its title, the two mandatory
sections and the three finding fields. Write `_No findings._` under a section
rather than omitting it.

The **State Inventory** comes before any finding, one row per candidate that
cleared part 1 of the qualifying bar; every finding cites a row.

The **Refactor Sketch** covers the single most critical finding only: a
before/after sketch in the project's own language — a discriminated union in
TypeScript, a JSDoc `@typedef` union plus one guard function in JavaScript, a
tagged class or an `enum` plus an exhaustive `match` in other languages, or a transition table with one
`transition(state, event)` function every writer goes through. It names which
writer sites move behind the guard and which combination becomes
unrepresentable. It is a sketch inside the report: this lens edits no code,
per the core's read-only constraint, and the fix lands through
`/audit-to-stories`.

```markdown
# State Machine Audit Report

## Executive Summary

[Headline read.]

Self-cross-check: kept <k> / dropped <d>.
Severity tally: Critical <n> / High <n> / Medium <n> / Low <n>

## State Inventory

| Candidate | Variables | Implicit states | Transitions (writers) | Impossible or unhandled combinations | Reachable |
| --- | --- | --- | --- | --- | --- |
| [name] | `path:line`, … | [states] | `path:line`, … | [combination] | [yes — finding title / no] |

## Detailed Findings

### `path/to/primary-file.ext` — [Short title of the issue]

- **Dimension:** [Boolean Soup | Status Sidecar | Scattered Transitions | Unhandled State | Distributed State]
- **Severity:** [Critical | High | Medium | Low | Info]
- **Variables:** [the co-varying set, `path:line` each]
- **Reachable Path:** [entry point → write at `path:line` → write at `path:line` → the bad combination]
- **Explicit Form:** [the replacement shape in a few lines]
- [Location, Current State, Recommendation & Rationale, Acceptance signal —
  per the core skeleton]

## Refactor Sketch

[The most critical finding's title. Before: the loose variables and their
writers. After: the explicit form and the one guard every writer calls. The
combination that becomes unrepresentable.]
```
