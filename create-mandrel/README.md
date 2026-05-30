# create-mandrel

Cold-start launcher for [Mandrel](https://github.com/dsj1984/mandrel) — the
zero-to-installed entry point for onboarding a project onto the framework.

## What it does

Run once from the root of your project:

```bash
npx create-mandrel [bootstrap flags...]
```

The launcher performs the minimum work needed to get Mandrel installed, then
hands off to the in-tree bootstrap:

1. **Vendors `.agents` (when absent).** If your project does not already have
   an `.agents` directory, the launcher adds Mandrel's distributed bundle as a
   Git submodule pinned to the `dist` branch:

   ```bash
   git submodule add -b dist https://github.com/dsj1984/mandrel.git .agents
   git submodule update --init -- .agents
   ```

2. **Skips the add when `.agents` already exists.** Re-running the launcher on
   a project that is already wired up goes straight to bootstrap, so the
   command is safe to run more than once.

3. **Runs bootstrap.** The launcher always finishes by invoking
   `node .agents/scripts/bootstrap.js`, forwarding every flag you passed
   through unchanged.

## Passthrough flags

Any flags you pass to `create-mandrel` are forwarded verbatim to
`bootstrap.js`. Common ones:

| Flag                       | Effect                                               |
| -------------------------- | ---------------------------------------------------- |
| `--assume-yes`             | Accept every default; required for non-TTY runs.     |
| `--skip-github`            | Skip the GitHub-side bootstrap entirely.             |
| `--owner <name>`           | GitHub owner (default: parsed from the origin remote).|
| `--repo <name>`            | GitHub repo (default: parsed from the origin remote). |
| `--dry-run`                | Print the resolved bootstrap plan without mutating.  |

Run `npx create-mandrel --help` to see the full bootstrap flag set (the
`--help` flag is forwarded to `bootstrap.js`).

Example non-interactive cold start:

```bash
npx create-mandrel --assume-yes --owner acme --repo widget
```

## Why the remote is hardcoded

The submodule remote URL is a build-time constant. It is **never** read from
an environment variable, a flag, or any other operator-supplied input. The
launcher's whole purpose is to make the provenance of `.agents/` non-negotiable
— accepting an operator-supplied URL would let a cold-start command vendor
arbitrary code into `.agents/` and execute it.

## Requirements

- Node.js `>=22.22.1 <25`
- Git (the launcher shells out to `git submodule`).
- The target directory must be inside a Git working tree (submodules require a
  repository).
