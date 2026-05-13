# Project Memory Index

- [Worktree untracked bootstrap files](feedback_worktree_untracked_files.md) — `.env` / `.mcp.json` don't propagate into worktrees; silent test breakage
- [story-close reap fully codified on Windows](feedback_sprint_story_close_reap.md) — post-`ff34fa9` Windows reap should be reliable; manual rmdir + prune + branch -D recipe still works as fallback
- [Orphan .worktrees break root biome lint](feedback_orphan_worktree_biome_block.md) — nested `biome.json` in partial-reap residue fails `npm run lint` at close time
- [Epic retro must be GitHub-only](feedback_retro_github_only.md) — don't use `notify.js` for retros; it fires the webhook. Use `postStructuredComment` instead
- [rm -rf .worktrees carve-out is a PreToolUse hook](feedback_rm_rf_worktrees_hook.md) — deny beats allow; narrow allow rules are ineffective against the global Bash(rm -rf *) deny
- [Notifier leaks real webhook in tests](feedback_webhook_leak_in_tests.md) — any test path that builds a Notifier/NotificationHook without stubbing `cwd` + `fetchImpl` POSTs to real Slack
- [Close-validation hits main checkout, not worktree](feedback_close_validation_main_drift.md) — pre-existing epic-branch format/MI-baseline drift blocks every story close
- [Push epic before re-running close after manual merge](feedback_close_push_epic_first.md) — stale `origin/epic/<id>` makes the script's rebase re-conflict on a different base
- [Post-merge push-hook cascade on epic-close](feedback_post_merge_push_hook_cascade.md) — `biome check` + MI gate run on push, not lint; check both pre-merge to avoid stuck commits
- [npm test flips core.bare on the main checkout](feedback_npm_test_flips_core_bare.md) — Git Graph / `git checkout` / story-close all fail with "must be run in a work tree"; fix: `git config core.bare false`
- [Concurrent story-close races epic HEAD](feedback_story_close_concurrent_lock.md) — parallel closes return `merged:true` but leave HEAD stale; `withEpicMergeLock` fix in flight 2026-05-07
- [/wave-execute degenerates under epic-execute fan-out](feedback_wave_execute_subagent_disambig.md) — "the sub-agent" wording in wave-execute.md was misread as self by general-purpose sub-agents; disambiguated 2026-05-07
- [Sub-agents lack the Agent tool](feedback_subagents_no_agent_tool.md) — nested Agent dispatch is unsupported in this Claude Code; flatten fan-out to the host or any wave-runner-as-sub-agent design fails
- [Windows CI coverage gate flaps under Node 22](feedback_windows_ci_coverage_flap.md) — tiny fractional branch deltas vary run-to-run; ratcheting from a failing run's artifact can chase the noise to a different file
- [delete-epic-branches misses flat story-NNNN naming](feedback_delete_epic_branches_naming.md) — script's regex expects `story/epic-<id>/<n>`; cross-check with `git branch -a | grep story` + worktree-list
- [post-merge-close ignores test sandbox tempRoot](project_phase_timings_uses_project_root.md) — phase-timings.json + reap-failure signals leak to real repo `temp/epic-<eid>/` regardless of `cwd:`/`tempRoot`
- [parallel-tooling.md trips story-init-not-backgrounded](feedback_parallel_tooling_scanner_collision.md) — helper documents Rule 2 + story-init anti-pattern within 20-line window; basename exclusion landed 5a42ff9d
- [single-story-close needs --skip-validation](feedback_single_story_close_skip_validation.md) — post-`1957d889` validation-evidence rejects `epicId=0` sentinel for standalone Stories
