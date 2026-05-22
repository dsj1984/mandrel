# npm install / npm ci call-site catalogue

Internal reference: every place in `.agents/scripts/**` that shells out to a
package manager (`npm install`, `npm ci`, `pnpm install`, `yarn install`) or
runs the test-coverage harness (which can re-trigger the install-time ajv
prune indirectly). Source-of-truth for Story #2505 (Epic #2501) — the
`nodeModulesStrategy: symlink` flip to `pnpm-store` and the `ajv` sentinel
test depend on knowing exactly where the dispatcher can dirty / re-prune
the host `node_modules` tree.

## Why this matters

Epic #2453 surfaced a recurring failure: `node_modules/ajv` disappeared
between dispatcher runs three separate times, breaking every
`.agents/scripts/*.js` CLI with `ERR_MODULE_NOT_FOUND: ajv`. The root cause
is the **symlink** `nodeModulesStrategy` — worktrees link to the host
`node_modules`, and any per-worktree install (or peer dep re-resolution)
prunes optional/transitive deps from the donor. Knowing the install
surface is a prerequisite for switching strategies safely.

## Call sites

| # | Path | Function / location | Command (argv) | When it fires | Notes |
| - | ---- | ------------------- | -------------- | ------------- | ----- |
| 1 | `.agents/scripts/lib/worktree/node-modules-strategy.js` | `selectInstallCommand()` → returns argv consumed by `WorktreeManager` | `pnpm install --frozen-lockfile` (when strategy=`pnpm-store` OR repo has `pnpm-lock.yaml`); `yarn install --frozen-lockfile` (yarn.lock); else `npm ci` | Once per worktree creation, **only** when strategy is `per-worktree` or `pnpm-store`. Returns `null` for `symlink`. | Retry policy from `installRetryPolicy()` — pnpm gets 3 attempts / 5 min; npm/yarn get 1 attempt / 2 min. |
| 2 | `.agents/scripts/lib/story-init/donor-precheck.js` | `runDonorInstallIfNeeded()` (line 184) | `npm ci` (hard-coded, **not** package-manager-aware) | When `nodeModulesStrategy=symlink` and the donor at `primeFromPath` has no `node_modules/`. One-shot, file-locked so concurrent story-init calls serialize. | This is the call that re-prunes optional peer deps (notably `ajv`) out of the host tree when run mid-session. Disappears once we leave `symlink`. |
| 3 | `.agents/scripts/lib/bootstrap/project-bootstrap.js` | `ensureDependenciesInstalled()` (line 133) | `<manager> install` where `<manager>` is detected from lockfiles (`pnpm` / `yarn` / `npm`) | First-time `bootstrap.js` run for a consumer project, or whenever the framework-managed `node_modules/ajv/package.json` sentinel is missing. | Already uses `ajv` as its presence-sentinel — confirms the dispatcher's hard runtime dependency on ajv. |
| 4 | `.agents/scripts/lib/coverage-capture.js` | `runCoverageOnce()` (line 183) | `npm run test:coverage` (an `npm run` script invocation, not a package install) | Story-close coverage-gate path and `audit-quality` workflow. | Not an install per se, but listed because the underlying `c8`/`node --test` chain has historically re-resolved peer deps and contributed to the ajv prune symptom under `symlink`. |
| 5 | `.agents/scripts/story-deliver-prepare.js` | `resolveInstallCommand()` (default), invoked from `runInstallIfNeeded()` | `npm ci` (default; overridable via `--install-cmd "<cmd>"` or `project.commands.install`) | Story-deliver bootstrap when `story-init` reports `dependenciesInstalled === 'false'` (install was attempted and failed). Skipped under `symlink` / `pnpm-store` because `dependenciesInstalled === 'skipped'`. | Caller-supplied override is the safety valve for non-npm projects. |

## Indirect / non-install npm invocations (FYI, not part of the prune surface)

These shell out to `npm` but never modify `node_modules` — listed for
completeness so future audits don't mistake them for install call sites:

- `lib/config/github.js` — `DEFAULT_REQUIRED_CHECKS` ships
  `['npm', 'run', 'lint']`, `['npm', 'run', 'format:check']`,
  `['npm', 'test']` as default branch-protection check argvs. Configuration
  payload only, not executed by the dispatcher.
- `git-pr-quality-gate.js` — same argv shapes as defaults for the local
  quality-gate runner; spawns `npm run lint` / `npm run format:check` /
  `npm test`. No install.
- `lib/close-validation.js` — emits `{ cmd: 'npm', args: ['test'] }` and
  `{ cmd: 'npm', args: ['run', 'lint'] }` entries for the close-validation
  chain. No install.
- `lib/bootstrap/ci-workflow-template.js` — text template that writes a
  GitHub Actions workflow containing `npm ci --ignore-scripts`. The
  template never runs during dispatcher execution; it just emits YAML.

## Implications for Story #2505

- **Switching `nodeModulesStrategy` from `symlink` to `pnpm-store`** removes
  call site #2 entirely (the donor-precheck `npm ci`) and routes worktree
  creation through call site #1's `pnpm install --frozen-lockfile` branch
  against the shared content-addressable store. The host `node_modules`
  tree stops being a shared mutation target, which is the upstream fix
  for the recurring `ajv` prune.
- **Call site #3** (`ensureDependenciesInstalled`) keeps `ajv` as its
  sentinel — the new `tests/sentinel/ajv-presence.test.js` (Task #2521)
  asserts the same invariant from the test side, so both paths agree on
  the contract.
- **Call sites #4 and #5** are unaffected by the strategy flip; documenting
  them here pre-empts a future "why didn't we touch coverage-capture?"
  question.

## Re-audit triggers

Re-run this catalogue when any of the following land:

- A new package manager is added to `detectPackageManager()` in
  `project-bootstrap.js`.
- A new worktree `nodeModulesStrategy` value is added to
  `applyNodeModulesStrategy()` / `selectInstallCommand()`.
- A new dispatcher entry point shells out to `npm` / `pnpm` / `yarn` with
  `install` or `ci` in its argv.
