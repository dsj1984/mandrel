---
name: diagnose-friction
description: >-
  Wrap a shell command with diagnostic capture. On failure, print static
  suggestions and append a structured `friction` record to the per-Story
  signals.ndjson stream. Use whenever a script in the orchestration loop
  invokes a tool whose failure shape we want the analyzer to attribute.
allowed_tools:
  - Bash
  - Read
---

# diagnose-friction

## Policy Capsule

- Invoke via the wrapping CLI `node .agents/scripts/diagnose-friction.js --story <id> [--epic <id>] --cmd <command args...>`; this is the single supported entry point.
- Pass the wrapped command's stdout and stderr through **unchanged** — never reformat, redact, or buffer in a way that loses the original failure shape.
- Never mutate the wrapped command's exit code. The Skill observes; the caller decides whether the failure is fatal.
- Operate as **best-effort observation**: a write failure on the signals stream MUST NOT halt the runner. A missing signal is preferable to a stalled wave.
- On non-zero exit append a `friction` NDJSON record (`kind`, `ts`, `category`, `detail`, `exitCode`) only through the signals writer helper — never open `signals.ndjson` directly.
- Resolve Story context from `--story` (and `--epic` when a run id applies); there is no body-parsing fallback — pass the flags explicitly.
- Do **not** post GitHub comments from this Skill. Friction is local NDJSON: the retro is what aggregates the stream and routes recurring friction into proposals (Story #4545 deleted `analyze-execution`, the perf-summary comment surface).
- Categorize failures deterministically (rebase abort, test-suite name, lint category, etc.) so the retro can attribute friction without re-running the command.

## Role

Diagnostic interceptor. Captures the failure shape of a wrapped command
and persists it as a structured signal so the retro can attribute friction
back to the Story without re-running the command.

## When to use

Any orchestration call site whose failure mode is informative
(rebase aborts, test failures with classifiable suite names, lint
errors with stable categories). The wrapping script today is
`diagnose-friction.js`; this Skill documents the contract for callers
that want to dispatch via the Skill tool rather than spawn the CLI.

## Inputs

- `--cmd <command args...>` — the command to invoke and observe.
- `--story <id>` / `--epic <id>` (optional) — when resolved, the Skill
  appends a `friction` signal to
  `temp/run-<eid>/stories/story-<sid>/signals.ndjson` on non-zero exit
  (standalone Stories: `temp/standalone/stories/story-<sid>/`).

## Outputs

- The wrapped command's stdout / stderr is passed through unchanged.
- On non-zero exit: a `friction` NDJSON record (kind, ts, category,
  detail, exitCode) is appended via the signals writer.
- No GitHub comments are posted — friction is a local NDJSON signal. The
  retro reads the stream out-of-band.

## Procedure

```bash
node .agents/scripts/diagnose-friction.js \
  --story <id> [--epic <id>] \
  --cmd <command args...>
```

The Skill's contract is "best-effort observation" — the wrapping
script never halts the runner because of a write failure. A missing
signal is preferable to a halted runner.

## Constraints

- Do **not** post GitHub comments from this Skill. Friction is local
  NDJSON; the retro owns the aggregate surface.
- Do **not** mutate the wrapped command's exit code. The Skill's job
  is observation; the caller decides whether the failure is fatal.
- Do **not** open `signals.ndjson` directly — use the signals writer
  helper so the file format and warn-once policy stay consistent.
