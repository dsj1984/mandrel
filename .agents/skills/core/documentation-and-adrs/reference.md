# Documentation and ADRs — Reference (on-demand)

**Read this when** a task engages one of the sections below and the Policy
Capsule in [`SKILL.md`](SKILL.md) does not settle it on its own. The capsule is
the contract; this file is the reference material behind it. Generic ADR
templates, inline-comment / README / changelog conventions, and JSDoc/OpenAPI
snippets are frontier-known and are not reproduced here — this file keeps the
project-specific contracts: the two decisions-log layouts and their loading
model, and the prune/archive convention for living docs.

## Decisions-log layouts

Mandrel ships **two supported layouts** for the decisions log. Both keep the
mandatory-read file named `docs/decisions.md` (the `project.docsContextFiles`
default), so `config-resolver.js` and every `.agents/` reference resolve the
same regardless of which you pick — only the **shape** differs. Choose one at
onboarding:

| Layout                              | Shape                                                                 | Template(s)                                                                                                | When to use                                                                       |
| ----------------------------------- | --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| **Single-file dated entries** (default) | One `decisions.md` of append-only `## YYYY-MM-DD — title` entries     | [`templates/docs/decisions.md`](../../../templates/docs/decisions.md)                                      | Small projects; a handful of decisions; you want everything in one scannable file. |
| **Index + `decisions/` directory**  | `decisions.md` is a one-row-per-ADR **index**; each ADR is `decisions/NNNN-*.md` | [`templates/docs/decisions.index.md`](../../../templates/docs/decisions.index.md) + [`templates/docs/decisions/_template.md`](../../../templates/docs/decisions/_template.md) | The log has outgrown a single file (dozens of ADRs); you want per-decision history and `git blame` per ADR. |

To adopt the directory layout, replace `decisions.md` with the index variant,
create a `decisions/` directory beside it, and scaffold each ADR from
`decisions/_template.md` using zero-padded sequential numbering
(`0001-*.md`, `0002-*.md`, …).

> **Loading model (resolved design question).** The decisions **index** is the
> only artifact loaded into mandatory task context — individual ADR bodies
> under `decisions/` are **lazy / link-followed**, not auto-loaded. This is
> **index-only by default**: auto-loading every ADR body into each task's
> context would reintroduce exactly the bloat the split exists to remove.
> `project.docsContextFiles` entries are plain filenames resolved against the
> docs root (no glob expansion in the loader), so the index ships as a normal
> mandatory-read with no loader change. A project that genuinely wants the full
> ADR set in mandatory context can add explicit per-file entries (or a
> `decisions/*.md`-style entry if it maintains its own globbing) as a
> deliberate opt-in, but that is the exception, not the default.

### ADR lifecycle (why archiving is not for ADRs)

```text
PROPOSED → ACCEPTED → (SUPERSEDED or DEPRECATED)
```

Don't delete old ADRs — they capture historical context. When a decision
changes, write a new ADR that references and supersedes the old one. An ADR that
no longer holds is **superseded in place**, keeping the numbered chain intact;
it is not pruned by archiving (see below).

## Pruning & Archiving

Living docs accrete history — dated changelog entries, closed decision-log rows,
completed rollout checklists, resolved runbook incidents. Left unpruned, that
verbatim history crowds out the live guidance a reader (human or agent) actually
needs, and every task that loads the doc re-pays the cost. The fix is to
**archive, don't delete**: relocate the cold history so the live doc stays lean
while the record stays recoverable.

### The archive-don't-delete rule

**History is preserved by _moving_ it, never by deleting it.** Pruning a doc
never destroys its past — the verbatim content is relocated to a dated archive
file under version control, so the full record remains diffable and recoverable.
Deleting history outright (even with "git has it") is the anti-pattern this
convention exists to prevent: the archive is discoverable from the live doc, a
buried git revision is not.

### How to prune a doc

1. **Extract the still-live signal first — before you archive anything.**
   Gotchas, traps, and hard-won caveats buried in the history are the most
   valuable lines in the doc. Lift them into the live doc's standing guidance (a
   "Known gotchas" list, an inline warning, or an ADR) **before** the history
   moves. Archiving first risks stranding a live trap in a cold file nobody
   rereads.
2. **Move the verbatim history to a dated archive file.** Relocate the cold
   content — untouched, word-for-word — to `docs/archive/<name>-<YYYY-MM>.md`,
   where `<name>` is the source doc's base name and `<YYYY-MM>` is the archive
   date (e.g. `docs/archive/changelog-2025-01.md`,
   `docs/archive/decisions-2024-11.md`). The archive is an exact copy of what
   was live; do not summarize or rewrite it in the move.
3. **Collapse completed checklists to a one-line summary.** A finished checklist
   (a rollout runbook, a migration plan, a release gate) does not need to keep
   every ticked box in the live doc. Replace it with a single line recording the
   outcome and date — e.g. `Auth-migration rollout — completed 2025-01-18, all
   12 steps green` — and let the archived copy carry the full detail.
4. **Leave a one-line pointer behind.** Every archived doc leaves exactly one
   line in the live doc pointing at where its history went, so the record is
   never orphaned — e.g. `Older entries archived to
   docs/archive/changelog-2024.md`. The pointer is what makes "moved, not
   deleted" true from the reader's vantage point.

### When to prune

- A changelog, decision log, or runbook has grown long enough that the live
  entries are hard to find among the historical ones.
- A checklist or rollout plan is fully complete and its step-by-step detail is
  now reference-only.
- A doc reloaded into agent context on many tasks carries more cold history than
  live guidance.

Do **not** prune ADRs by archiving — an ADR that no longer holds is
**superseded** in place (see [ADR lifecycle](#adr-lifecycle-why-archiving-is-not-for-adrs)),
keeping the numbered chain intact. Archiving is for the accreted history of
living docs, not for the immutable decision record.
