---
description: Initialize GitHub repo with v5 label taxonomy and project fields
---

# /agents-bootstrap-github

## Purpose

Idempotent setup of the v5 Epic-centric orchestration infrastructure on the
target GitHub repository. Creates the required label taxonomy and project board
custom fields.

## Constraint

- **Persona**: `engineer`
- **Read-Only Context**: `.agentrc.json` orchestration block
- **Idempotent**: Safe to run multiple times — skips resources that exist
- **Destructive Actions**: None — only creates, never deletes or modifies
  existing labels or fields

## Steps

1. **Verify Configuration**: Read `.agentrc.json` and confirm the
   `orchestration` block is present and valid.

2. **Run Bootstrap Script**:

   ```bash
   node .agents/scripts/agents-bootstrap-github.js
   ```

3. **Review Output**: The script prints a summary of created vs. skipped
   resources. Verify the counts match expectations.

4. **Verify in GitHub UI** (optional): Navigate to the repository's Labels page
   and Project board to confirm resources were created with correct colors and
   field options.

## What Gets Created

### Labels

| Category    | Labels                                                                                   | Color  |
| ----------- | ---------------------------------------------------------------------------------------- | ------ |
| Type        | `type::epic`, `type::feature`, `type::story`, `type::task`                               | Purple |
| Agent State | `agent::review-spec`, `agent::ready`, `agent::executing`, `agent::review`, `agent::done`, `agent::blocked` | Green  |
| Epic        | `epic::auto-close`                                                                       | Yellow |
| Status      | `status::blocked`                                                                        | Red    |
| Risk        | `risk::medium`                                                                           | Yellow |
| Persona     | `persona::<name>` — one per file in `.agents/personas/`                                  | Blue   |
| Context     | `context::prd`, `context::tech-spec`                                                     | Purple |
| Execution   | `execution::sequential`, `execution::concurrent`                                         | Peach  |

### Project Board Fields (if `projectNumber` is configured)

- **Sprint** (Iteration)
- **Execution** (Single Select): `sequential`, `concurrent`

## Troubleshooting

- **"No orchestration block"**: Add the `orchestration` object to your
  `.agentrc.json`. Copy from `.agents/default-agentrc.json`.
- **"API access verification failed"**: Check your `GITHUB_TOKEN` has `repo` and
  `project` scopes, or run `gh auth login`.
- **Rate limiting**: The script makes one API call per missing label. For large
  taxonomies, you may hit GitHub's rate limit. Re-run — it's idempotent.
