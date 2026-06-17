# Architectural Decisions Log (Index)

> **Directory-layout variant.** This is the MADR-style **index + `decisions/`
> directory** alternative to the default single-file dated-entry
> [`decisions.md`](decisions.md). To adopt it, replace your `decisions.md` with
> this index, create a `decisions/` directory next to it, and scaffold ADRs
> from [`decisions/_template.md`](decisions/_template.md). This file stays named
> `decisions.md` so it remains the `project.docsContextFiles` mandatory-read
> every `.agents/` reference and `config-resolver.js` already point at — only
> its **shape** changes from dated entries to an index.
>
> Prefer this layout once the single-file log grows past a few dozen entries
> (athportal hit ~1060 lines / 32 ADRs before splitting). For small projects,
> keep the default single-file template instead.

## How this layout works

- **This file is the index** — one row per ADR, newest at the top. It is the
  mandatory-read; agents scan the index and follow the link into a specific
  ADR only when the detail is relevant (index-only by default — see
  [Loading model](#loading-model)).
- **Each ADR is its own file** under `decisions/`, named
  `NNNN-<kebab-title>.md` with a zero-padded sequential number.
- **ADRs are append-only.** Never rewrite or delete an accepted ADR — write a
  new one and flip the old one's status to `Superseded by ADR-NNNN`.
- **Scaffold new ADRs** from [`decisions/_template.md`](decisions/_template.md)
  (Status / Date / Deciders / Context / Decision / Consequences).

## Loading model

This index is the only decisions artifact loaded into mandatory task context
(`project.docsContextFiles`). Individual ADR bodies under `decisions/` are
**lazy / link-followed**, not auto-loaded — that is the whole point of the
split: keep the per-task context lean while preserving the full decision
history on disk. If a project genuinely wants the entire ADR set in mandatory
context, it can add an explicit `decisions/*.md`-style entry to
`project.docsContextFiles` as an opt-in (see the configuration reference), but
index-only is the intended default.

## Index

| ADR      | Title                                    | Status   | Date       |
| -------- | ---------------------------------------- | -------- | ---------- |
| ADR-0001 | _Example — replace with your first ADR_  | Proposed | YYYY-MM-DD |

_Add new rows above this line, newest first. Once you scaffold a real ADR from
[`decisions/_template.md`](decisions/_template.md) into
`decisions/0001-<title>.md`, link the ADR id to that file (e.g.
`[ADR-0001](decisions/0001-<title>.md)`) and delete this example row._
