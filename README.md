# Mandrel

[![CI / CD](https://github.com/dsj1984/mandrel/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/dsj1984/mandrel/actions/workflows/ci.yml)

An opinionated workflow framework for AI coding assistants built on
Story-centric GitHub orchestration. Planning, execution, and state all live
natively in GitHub Issues, Labels, and Projects V2.

## Prerequisites

Mandrel is distributed as the
[`mandrel`](https://www.npmjs.com/package/mandrel) npm
package and wires its orchestration into your project's GitHub repository.
You do **not** need a pre-created Git repo or GitHub remote — `bootstrap.js`
provisions both as part of a cold start (`git init` → `gh repo create --push`
→ `gh project create`). You need:

- **Node.js** >= 22.22.1 (< 25).
- **`git`** on your `PATH`.
- **GitHub CLI `gh`** >= 2.40, authenticated — run `gh auth login` once so
  orchestration scripts pick up your token from the OS keychain. A vanilla
  `gh auth login` token does **not** carry the `project` scope needed to
  provision the GitHub Projects V2 board; bootstrap degrades to
  warn-and-skip-board in that case (no hard failure). To enable board
  provisioning, grant the scope with `gh auth refresh -s project` (re-auth
  in the browser when prompted) before running `bootstrap.js`.

## Quickstart

The canonical cold-start path is one command, then one slash command:

```bash
npx mandrel init        # install mandrel → sync → prompt → bootstrap → onboarding tail → /plan handoff
```

```text
# then, inside Claude Code (commands load from .claude/commands/):
/plan --seed "…"   # interrogate → author one Story (default) → persist
/deliver <id>      # story-<id> → PR → main
```

`npx mandrel init` installs `mandrel` (when `./.agents/` is absent),
materializes it via `mandrel sync`, then asks whether to **configure now**
(option 1 → runs `bootstrap.js`, then the onboarding tail: stack detection,
docs scaffolding offer, `mandrel doctor` readiness gate, and a `/plan`
handoff) or stop at **just the files** (option 2 → re-run `mandrel init`
any time to configure). Pass `--assume-yes` for a non-interactive run that
proceeds straight to configure (and forwards the flag to bootstrap). When
`./.agents/` is already present (you ran `npm install mandrel` first), `init`
skips the install/sync and goes straight to the prompt. Once `mandrel init`
completes, you land at the `/plan` handoff — run `/plan --seed "<idea>"` to
author your first Story, then deliver it with `/deliver <storyId>`
(`story-<id>` → PR → `main`).

### Manual equivalent

If you prefer to drive the steps `mandrel init` wraps by hand, run them from
your project root:

```bash
npm install mandrel   # pin an exact, provenance-signed version
npx mandrel sync                # materialize ./.agents/ from the package
node .agents/scripts/bootstrap.js
```

`npm install mandrel` pins an exact, provenance-signed version in
your lockfile. The package's `postinstall` hook runs `mandrel sync`
best-effort, so `./.agents/` is usually materialized automatically; the
explicit `npx mandrel sync` above is the belt-and-suspenders step for
`--ignore-scripts` or sandboxed-CI installs. Run `npx mandrel doctor` any
time to confirm the install is healthy.

> **pnpm users — hoist mandrel's runtime deps.** The materialized
> `./.agents/scripts/*.js` run from your project root and resolve their
> third-party deps (ajv, js-yaml, …) from your top-level `node_modules`.
> npm and yarn hoist transitive deps there automatically; pnpm's default
> isolated layout does **not** — it keeps them in the `.pnpm` virtual store,
> so the framework scripts (and `mandrel doctor`'s `runtime-deps` check)
> cannot see them. Add the following to your `.npmrc` before installing:
>
> ```ini
> # Lift mandrel's runtime deps to the top-level node_modules so the
> # materialized .agents/scripts can resolve them.
> shamefully-hoist=true
> ```
>
> Prefer a surgical alternative? Replace `shamefully-hoist` with a scoped
> `public-hoist-pattern[]=` line per package listed in
> `.agents/runtime-deps.json` (`ajv`, `ajv-formats`, `js-yaml`, `minimatch`,
> `picomatch`, `string-argv`, `typhonjs-escomplex`). If `mandrel doctor`
> reports `runtime-deps missing: …`, this is the fix.

`bootstrap.js` is interactive on a TTY and auto-accepts the
owner/repo/base branch/operator handle it can infer from your local
`git remote` and `git config user.name` — you only get prompted for
fields it can't infer (typically the optional Projects V2 number). When the
folder is not yet a git repo, or the GitHub repo doesn't exist, it
provisions them: `git init` plus a first commit, then
`gh repo create --source=. --push` (use `--visibility private|public|internal`,
default `private`, to set the new repo's visibility), then `gh project create`
for the Projects V2 board. Override anything inferred with `--owner`,
`--repo`, `--base-branch`, or `--operator-handle`. For CI / scripted installs
pass `--assume-yes` plus whichever overrides you need. The script is
idempotent — safe to re-run anytime.

For the consumer reference and the end-to-end workflow narrative, see
[`.agents/README.md`](.agents/README.md) and
[`.agents/docs/SDLC.md`](.agents/docs/SDLC.md). Every `.agentrc.json` key is
documented in [`.agents/docs/configuration.md`](.agents/docs/configuration.md), and the
slash-command index lives in
[`.agents/docs/workflows.md`](.agents/docs/workflows.md).

## Update

Advance `mandrel` to the newest published version and
re-materialize `./.agents/` in one command:

```bash
npx mandrel update
```

`mandrel update` runs an ordered cycle:

1. **Resolve** the newest published version (a `npm view mandrel
   version` registry probe) and the currently installed version.
2. **No-op short-circuit** — already on the newest version ⇒ nothing to do.
3. **Install** the target version with the project's package manager —
   auto-detected from the lockfile (`pnpm-lock.yaml` ⇒ pnpm, `yarn.lock` ⇒
   yarn, otherwise npm) so the bump lands in your real lockfile. The
   dependency bump is left **staged** on disk — `mandrel update` performs no
   `git add` / `git commit`, so you review and commit the lockfile change
   yourself.
4. **Sync** — re-materialize `./.agents/` from the freshly installed payload.
5. **Migrate** — apply version-keyed migration steps for the crossed range.
6. **Doctor** — run the check registry to verify the resulting install.
7. **Surface** the target changelog section.

### Flags

- `--dry-run` — print the resolved target version and the ordered step
  plan, then exit. No dependency is bumped, no file is written, no seam
  runs.
- `--install-cmd "<cmd>"` — override the auto-detected install command. The
  package manager is normally detected from your lockfile
  (`pnpm-lock.yaml` ⇒ `pnpm add -D …`, `yarn.lock` ⇒ `yarn add -D …`,
  otherwise `npm install …`), so an override is rarely needed. When you do
  pass one, a `{target}` placeholder is substituted with the resolved newest
  version — e.g. `--install-cmd "pnpm add -D mandrel@{target} -w"` —
  so the override can still consume the auto-probed version. The registry
  probe always stays on `npm view` (it is a PM-agnostic registry query).

### Manual equivalent

If you prefer to drive the steps by hand:

```bash
npm install mandrel@latest   # or pnpm add / yarn up
npx mandrel sync                        # re-materialize ./.agents/
npx mandrel doctor                      # verify the install
```

## Benchmarking

Mandrel's effectiveness is measured by a separate companion repo,
**[mandrel-bench](https://github.com/dsj1984/mandrel-bench)** — a *consumer* of
the published `mandrel` package. It pins a specific framework version,
materializes it via `mandrel sync`, and drives Mandrel's own `/plan`→`/deliver`
pipeline (plus a bare-model control) over a scenario corpus. Each run is scored
across five dimensions — Quality, Planning fidelity, and Autonomy (what the
scaffolding *buys*) versus Efficiency and Overhead ratio (what it *costs*) —
reported as distributions with a noise-band, tracking the framework's
**value-add over the bare-model baseline** across versions and models.

The benchmark lives in its own repo on purpose: holding the harness fixed while
varying the pinned `mandrel` version cleanly decouples harness-version from
framework-version, and running through the published-package + `mandrel sync`
path exercises the real consumer contract. The dependency is one-directional —
`mandrel-bench` depends on `mandrel`, never the reverse. See the
[mandrel-bench README](https://github.com/dsj1984/mandrel-bench#readme) for the
dimensions, run model, and how to benchmark a new version.

## Contributors

Only `.agents/` is distributed to consumers — it ships inside the
`mandrel` npm package and is materialized into a consumer's
`./.agents/` directory by `mandrel sync`. Everything else in this
repository is internal development tooling.

Common commands while developing the framework itself:

```bash
npm run lint           # markdown + biome
npm run format         # auto-format
npm test               # framework tests
npm run test:coverage  # tests with coverage gate
```

Deeper reference material lives in `docs/` rather than inline here:

- [`docs/architecture.md`](docs/architecture.md) — module map, repo
  layout, state machine, and tech stack.
- [`.agents/docs/configuration.md`](.agents/docs/configuration.md) — every `.agentrc.json`
  key explained.
- [`.agents/docs/workflows.md`](.agents/docs/workflows.md) — slash-command
  index (auto-generated from the workflow set).
- [`docs/CHANGELOG.md`](docs/CHANGELOG.md) — release history.
- [`AGENTS.md`](AGENTS.md) — repository onboarding, the single-package release
  topology, PAT / npm-token setup, and major-version policy. Releases are
  automated by `release-please`: land Conventional Commits on `main` and it
  opens a combined `chore: release main` PR that squash-merges itself once
  CI is green, tags `main`, and publishes `mandrel` to npm.

Install scripts are disabled by default: the committed
[`.npmrc`](.npmrc) sets `ignore-scripts=true`, so `npm install` / `npm ci`
will not execute dependency lifecycle hooks — a defense-in-depth measure
against malicious lifecycle scripts in compromised transitive packages
(CWE-1357). CI passes `--ignore-scripts` explicitly. If you knowingly need
install scripts for a specific install, run
`npm install --ignore-scripts=false` for that invocation only.

CRAP and Maintainability gates fire at three sites — close-validation
(story close), `.husky/pre-push`, and CI (`ci.yml`, push + PR) — against
the same thresholds from `delivery.quality.*` in `.agentrc.json`.

## License

MIT
