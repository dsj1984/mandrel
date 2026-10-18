---
name: documentation-and-adrs
description:
  Records decisions and documentation. Use when making architectural decisions,
  changing public APIs, shipping features, or when you need to record context
  that future engineers and agents will need to understand the codebase.
---

# Documentation and ADRs

## Policy Capsule

- Document the **why**, not the what. Capture context, constraints, alternatives considered, and trade-offs — code already shows what was built.
- Write an ADR for any decision that would be expensive to reverse (framework choice, data model, auth strategy, API architecture, hosting platform).
- Mandrel ships **two first-class decisions-log layouts** — pick one at onboarding (see [Decisions-log layouts](reference.md#decisions-log-layouts)): the **single-file dated-entry** `docs/decisions.md` (default; best for small projects) or the **index + `docs/decisions/` directory** (MADR-style, one file per ADR; best once the log outgrows a single file). Either way, the canonical ADR sections are **Status, Date, Deciders, Context, Decision, (Alternatives Considered), Consequences**.
- Mark an ADR's status as `Accepted`, `Superseded by ADR-XXX`, `Deprecated`, or `Reverted (<date>)` — a reverted decision was **undone** rather than replaced, so unlike a superseded one it has no successor to point at. Never silently delete an ADR — supersede it.
- Keep user-facing docs (README, API docs, changelog) updated as part of the change — out-of-date docs are bugs.
- Pair every public API change with a changelog entry that links the relevant Story and any superseding ADR.

## Long-form reference — read on demand

The capsule above is the contract and the whole always-read surface of this
skill. The project-specific material behind it — the decisions-log layouts and
the prune/archive procedure — lives in the on-demand sibling
[`reference.md`](reference.md), matching the split the always-on rules already
use ([`rules/git-conventions.md`](../../../rules/git-conventions.md) ⇄
[`git-conventions-reference.md`](../../../rules/git-conventions-reference.md)).
Activating this skill costs the capsule; open a section below only when the
task actually engages it.

- [Decisions-log layouts](reference.md#decisions-log-layouts)
- [Pruning & Archiving](reference.md#pruning--archiving)
