# Upgrading across a major version (breaking-change runbook)

This is the runbook the `mandrel update` **major gate** points you at. When the newest published `@mandrelai/agents` crosses a major boundary (for example `1.x → 2.0`), `mandrel update` **refuses to apply it automatically** — it prints the available version, a pointer to this document, and exits non-zero without mutating anything. You cross the boundary deliberately, with this runbook in hand, by re-running with `--major`.

> **Why a major is gated.** Mandrel lives on the **1.x** line and is released by `release-please` with `versioning: always-bump-minor` — routine work only ever advances the **minor** axis, even when a commit carries a `BREAKING CHANGE:` footer. A **major release is a deliberate, manual operator decision** on the framework side ([AGENTS.md § Major-version policy](../AGENTS.md)): an operator sets the version explicitly via a `Release-As: X.0.0` trailer or an in-place version edit on the release PR. The consumer-side major gate is the mirror image of that manual step: just as a major release cannot be cut by reflex, a major upgrade cannot be **adopted** by reflex. Minor and patch bumps within the 1.x line are never gated — only the rare major crossing is.

---

## What "breaking" means here, in npm terms

Mandrel follows a **hard-cutover contract** ([`.agents/rules/git-conventions.md` § Contract Cutovers](../.agents/rules/git-conventions.md)): there is **no shim layer** and **no parallel old-shape support**. When a contract changes — a config shape, a baseline shape, a JSON schema, a lifecycle payload, a ticket label, a dispatch artifact, or the public API of a script — the change ships as a single in-tree migration that moves every producer and consumer in one pass. The old shape is deleted in the same release; it is not kept alive behind a flag for a deprecation window.

In npm terms this means:

- **The package version *is* the contract version.** Your lockfile pins an exact `@mandrelai/agents` version, so you are always reading exactly one shape of every artifact — the one that ships in the version you installed. There is no "compatibility mode" to fall back to.
- **A major bump signals a hard cutover.** A `1.x → 2.0` crossing is the framework telling you that at least one contract shape changed with no backward-compatible reader. You adopt the new shape by upgrading the package; the **PR diff for the version bump is the migration boundary**.
- **Migrations run forward only.** `mandrel update` runs the version-keyed migration steps for the range you are crossing (each step is idempotent and prints what it changed and why). There is no down-migration: to revert, you pin the previous version in your lockfile and re-`sync`.

Because there is no shim, **read the target version's changelog before you cross**. The relevant `docs/CHANGELOG.md` sections ship inside the package payload and are surfaced by `mandrel update`; they map to Conventional-Commit types and call out the breaking entries.

---

## The `--major` upgrade procedure

Do this on a branch, in a clean working tree, so the whole upgrade is one reviewable PR.

### 1. Confirm the gate fired and read the target

Running a plain update against a major surfaces the refusal:

```bash
npx mandrel update
# → declines: "a newer MAJOR version (2.0.0) is available; this is a breaking
#   upgrade. Review docs/upgrade-major.md, then re-run with --major." (exit 1)
```

Inspect the plan without writing anything:

```bash
npx mandrel update --major --dry-run
```

`--dry-run` reports the target version, which migration steps would run, and the major-gate decision — and writes nothing. Read the surfaced changelog for the breaking entries before continuing.

### 2. Apply the major upgrade

```bash
npx mandrel update --major
```

With `--major`, `mandrel update` runs the full cycle and prints the breaking-change notes inline:

1. **npm install.** It installs `@mandrelai/agents@<2.0.0>` via npm. The lockfile change is **left staged, never committed** — `mandrel update` performs no `git` mutation, matching the "operator commits the lockfile" contract.
2. **Re-materialize.** It runs `mandrel sync` so `./.agents/` reflects the new package payload (a plain file copy; your `.agents/local/` zone is never touched).
3. **Migrate.** It runs every version-keyed migration step in the `installed → target` range, in ascending version order. Each applied step prints an actionable `migrated: <file> — <what changed / why>` line. Migrations are idempotent, so a re-run is a safe no-op.
4. **Verify with doctor.** It runs `mandrel doctor` and reports success **only when every check passes**. A failing doctor makes `update` exit non-zero so you treat the upgrade as incomplete rather than done.
5. **Surface the changelog.** It prints the `docs/CHANGELOG.md` sections spanning the applied version range so the breaking entries are in front of you.

### 3. Resolve anything the migrations could not

A hard cutover sometimes changes a shape that a migration step cannot infer automatically (for example, a renamed config key whose new value depends on a project decision). When that happens:

- The migration step's message names the file and the decision you need to make.
- `mandrel doctor` fails with a specific, file-named remedy (drift, schema mismatch, or a missing required key).

Make the edit the message asks for, then re-run `npx mandrel doctor` until it reports `✅  Ready (N/N checks passed)`. Re-running `mandrel update --major` is also safe — the npm install and migrations are idempotent.

### 4. Commit the upgrade

Once doctor is green, stage and commit the lockfile bump, the re-materialized `./.agents/` tree, and any config edits the migrations required — as **one** reviewable commit:

```bash
git add -A
git commit -m "build: upgrade @mandrelai/agents to 2.0.0"
```

Open a PR so the breaking diff is reviewed before it lands on your default branch.

---

## If a dependency bot opened the major PR

Renovate and Dependabot are configured to **hold** the `1.x → 2.0` major for manual review and never auto-merge it (see [`renovate-dependabot.md`](renovate-dependabot.md)). Do **not** merge a bot's major PR by clicking merge — that adopts the breaking shape without running migrations. Instead:

1. Close or ignore the bot's major PR (or leave it open as a reminder).
2. Follow the `--major` procedure above on your own branch, which runs the migrations and the doctor gate.
3. Merge **your** PR — the one with the migrated config and the green doctor — not the bot's bare version bump.

---

## Reverting

There is no down-migration. To roll back a major you adopted:

```bash
npm install @mandrelai/agents@<previous-1.x-version>
npx mandrel sync
npx mandrel doctor
```

Then revert any config edits the forward migrations made (your version-control history of the upgrade PR is the record of what changed). Because the previous version's payload is a different contract shape, pin it explicitly in your lockfile and re-`sync` so `./.agents/` matches the version you rolled back to.

---

## Related documents

| Document | Purpose |
| --- | --- |
| [`renovate-dependabot.md`](renovate-dependabot.md) | Dependency-bot config that gates Mandrel bumps on `mandrel doctor` and holds majors for manual review |
| [`migration-submodule-to-npm.md`](migration-submodule-to-npm.md) | One-time migration from the retired `dist`-branch submodule to the npm package |
| [`compatibility-matrix.md`](compatibility-matrix.md) | Supported OS / Node / package-manager combinations |
| [AGENTS.md § Major-version policy](../AGENTS.md) | The framework-side manual major-release step this gate mirrors |
| [`.agents/rules/git-conventions.md` § Contract Cutovers](../.agents/rules/git-conventions.md) | The hard-cutover / no-shim policy a major expresses |
