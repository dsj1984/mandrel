# Shell & Terminal Conventions

This rule applies when running shell commands during agent execution. The host
shell varies — agents must adapt to the environment.

## Detecting the Shell

Before chaining commands, check the host shell. Common signals:

- `$env:COMSPEC` set / `pwsh.exe` or `powershell.exe` → PowerShell
- `$SHELL` set to `/bin/bash`, `/bin/zsh`, etc. → POSIX shell
- Claude Code system prompt or harness directive announces the shell

## PowerShell (Windows)

PowerShell 5.1 (default on Windows) does **not** support `&&` as a statement
separator and will throw a parser error. PowerShell 7+ does, but agents
running on Windows should not assume version 7+.

- **Standard separator**: `;` runs the next command regardless of the first's
  exit status.
- **Success chaining (logical AND)**: `; if ($?) { ... }` runs the second
  command only when the first succeeded.
- **Example**: `git add . ; if ($?) { git commit -m "..." }`

Other PowerShell-isms agents must respect:

- Use `$null` (not `/dev/null`).
- Use `$env:VAR` (not `$VAR`).
- Use backtick (`` ` ``) for line continuation, not backslash.

## POSIX Shells (bash / zsh)

`&&` and `||` work natively. No translation needed.

- **Success chaining**: `cmd1 && cmd2`
- **Fallback**: `cmd1 || cmd2`

## Cross-Platform Tips

- Prefer the host's tool wrappers (Bash tool, etc.) over raw shell strings
  when the harness exposes them — they normalize quoting and escaping.
- For multi-step pipelines that must run identically across platforms, write
  a Node/Python script and invoke that, rather than chaining shell builtins.

## Searching the Workspace

When searching for strings, patterns, or files, prioritize speed and avoid
pipeline bottlenecks or full-file reads. Use this decision tree:

1. **Host grep tool first.** If the harness exposes a dedicated grep tool
   (e.g. Claude Code's `Grep` tool, ripgrep wrappers), use it. These
   normalize quoting, respect `.gitignore`, and stream results.
2. **`git grep`** when the workspace is a git repo and no host tool is
   available. Pass `-l` to list only filenames when paths are sufficient.
3. **`rg` (ripgrep)** when installed and outside a git repo, or when you
   need features `git grep` lacks (multiline, type filters).
4. **Avoid full-file reads** for searches. Reading whole files into memory
   to scan for a pattern wastes context and is slower than a streaming
   grep.

### PowerShell-specific anti-patterns

- If you must use `Select-String`, pass `-List` when you only need to
  detect existence or collect file paths — without it, every match streams
  through the pipeline.
- NEVER chain `Select-Object -Unique` or `Sort-Object` directly after a
  highly recursive `Get-ChildItem` on large trees. Both block the pipeline,
  hold every result in memory, and frequently hang the terminal. Stream
  through `Where-Object` filters first, or pre-narrow with a glob.
