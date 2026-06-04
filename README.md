# Mandrel

[![CI / CD](https://github.com/dsj1984/mandrel/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/dsj1984/mandrel/actions/workflows/ci.yml)

An opinionated workflow framework for AI coding assistants built on
Epic-centric GitHub orchestration. Planning, execution, and state all live
natively in GitHub Issues, Labels, and Projects V2.

## Prerequisites

Mandrel is installed **into an existing project** from the
[`@mandrelai/agents`](https://www.npmjs.com/package/@mandrelai/agents) npm
package and wires its orchestration into that project's GitHub repository.
Before you run `bootstrap.js` you need:

- **An existing Git repository** — clone or `cd` into the project you
  want to add Mandrel to. The framework cannot bootstrap a brand-new,
  unversioned directory.
- **A GitHub remote on that repository** — `origin` must point at a
  GitHub repo that already exists (e.g. `github.com/<owner>/<repo>`).
  `bootstrap.js` creates labels, Projects V2 fields, and branch
  protections **on that remote**, so it cannot run against a local-only
  repo or one whose remote hasn't been created yet. Create the empty
  GitHub repo first (`gh repo create` or via the web UI) and `git push`
  at least once so the remote exists.
- **Node.js** >= 22.22.1 (< 25).
- **GitHub CLI `gh`** >= 2.40 — run `gh auth login` once so orchestration
  scripts pick up your token from the OS keychain.

See [`docs/compatibility-matrix.md`](docs/compatibility-matrix.md) for the
supported OS / Node / package-manager combinations.

## Install & Setup

From the root of your existing Git repository (with its GitHub remote
already configured — see Prerequisites):

```bash
npm install @mandrelai/agents
npx mandrel sync            # materialize ./.agents/ from the installed package
node .agents/scripts/bootstrap.js
# in your agentic IDE:
/epic-plan          # ideation -> PRD/Tech Spec -> Epic/Feature/Story hierarchy
/epic-deliver <id>  # wave loop -> validation -> review -> retro -> open PR
```

`npm install @mandrelai/agents` pins an exact, provenance-signed version in
your lockfile. The package's `postinstall` hook runs `mandrel sync`
best-effort, so `./.agents/` is usually materialized automatically; the
explicit `npx mandrel sync` above is the belt-and-suspenders step for
`--ignore-scripts` or sandboxed-CI installs. Run `npx mandrel doctor` any
time to confirm the install is healthy.

> **Already on the old Git submodule?** Follow the one-time
> [submodule-to-npm migration guide](docs/migration-submodule-to-npm.md).

`bootstrap.js` is interactive on a TTY and auto-accepts the
owner/repo/base branch/operator handle it can infer from your local
`git remote` and `git config user.name` — you only get prompted for
fields it can't infer (typically the optional Projects V2 number).
Override anything inferred with `--owner`, `--repo`, `--base-branch`,
or `--operator-handle`. For CI / scripted installs pass `--assume-yes`
plus whichever overrides you need. The script is idempotent — safe to
re-run anytime.

For the consumer reference and the end-to-end workflow narrative, see
[`.agents/README.md`](.agents/README.md) and
[`.agents/SDLC.md`](.agents/SDLC.md). Every `.agentrc.json` key is
documented in [`docs/configuration.md`](docs/configuration.md), and the
slash-command index lives in [`docs/workflows.md`](docs/workflows.md).

## Update

Advance `@mandrelai/agents` to the newest published version and
re-materialize `./.agents/` in one command:

```bash
npx mandrel update
```

`mandrel update` runs an ordered cycle:

1. **Resolve** the newest published version (a `npm view @mandrelai/agents
   version` registry probe) and the currently installed version.
2. **Major gate** — if the newest version crosses a major boundary
   (e.g. `1.x → 2.0`), the command declines, prints a pointer to
   [`docs/upgrade-major.md`](docs/upgrade-major.md), and exits non-zero
   without touching anything. Re-run with `--major` to apply it.
3. **No-op short-circuit** — already on the newest version ⇒ nothing to do.
4. **Install** the target version (the dependency bump is left **staged**
   on disk — `mandrel update` performs no `git add` / `git commit`, so you
   review and commit the lockfile change yourself).
5. **Sync** — re-materialize `./.agents/` from the freshly installed payload.
6. **Migrate** — apply version-keyed migration steps for the crossed range.
7. **Doctor** — run the check registry to verify the resulting install.
8. **Surface** the target changelog section.

### Flags

- `--dry-run` — print the resolved target version and the ordered step
  plan, then exit. No dependency is bumped, no file is written, no seam
  runs.
- `--major` — apply a major-version crossing that the gate would otherwise
  refuse. Review [`docs/upgrade-major.md`](docs/upgrade-major.md) first.
- `--install-cmd "<cmd>"` — override the install command for pnpm/yarn
  workspaces. The default is `npm install @mandrelai/agents@<target>`; pass
  e.g. `--install-cmd "pnpm add @mandrelai/agents@<target>"` so the bump
  lands in your real lockfile rather than writing a stray
  `package-lock.json`. The registry probe always stays on `npm view` (it is
  a PM-agnostic registry query).

### Manual equivalent

If you prefer to drive the steps by hand:

```bash
npm install @mandrelai/agents@latest   # or pnpm add / yarn up
npx mandrel sync                        # re-materialize ./.agents/
npx mandrel doctor                      # verify the install
```

## Contributors

Only `.agents/` is distributed to consumers — it ships inside the
`@mandrelai/agents` npm package and is materialized into a consumer's
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
- [`docs/configuration.md`](docs/configuration.md) — every `.agentrc.json`
  key explained.
- [`docs/workflows.md`](docs/workflows.md) — slash-command index.
- [`docs/CHANGELOG.md`](docs/CHANGELOG.md) — release history.
- [`AGENTS.md`](AGENTS.md) — repository onboarding, the two-package release
  topology, PAT / npm-token setup, and major-version policy. Releases are
  automated by `release-please`: land Conventional Commits on `main` and it
  opens a combined `chore: release main` PR that squash-merges itself once
  CI is green, tags `main`, and publishes `@mandrelai/agents` to npm.

Install scripts are disabled by default: the committed
[`.npmrc`](.npmrc) sets `ignore-scripts=true`, so `npm install` / `npm ci`
will not execute dependency lifecycle hooks — a defense-in-depth measure
against malicious lifecycle scripts in compromised transitive packages
(CWE-1357). CI passes `--ignore-scripts` explicitly. If you knowingly need
install scripts for a specific install, run
`npm install --ignore-scripts=false` for that invocation only.

CRAP and Maintainability gates fire at every checkpoint (keystroke,
pre-commit, pre-push, story-close, CI, Epic merge) against the same
thresholds from `delivery.quality.*` in `.agentrc.json`.

## License

MIT
