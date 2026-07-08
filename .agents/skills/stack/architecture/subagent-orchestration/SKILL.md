---
name: subagent-orchestration
description:
  Coordinates complex tasks via task-isolated subagents. Use when one objective
  is too large for a single agent or when independent work streams should run
  concurrently with minimal context bleed. One objective per subagent;
  summarize before returning to keep the orchestrator's context window clean.
  Applies recursively — an orchestrator at any supported nesting depth applies
  the same policy to its own children.
---

# Skill: Subagent Orchestration

## Recursive orchestration model

This skill describes **recursive orchestration**, not a fixed two-tier
"main agent vs. subagents" split. An **orchestrator** is any agent that
dispatches sub-agents; a sub-agent is itself an orchestrator over its own
children. The Claude Code harness carries the `Agent` tool into sub-agents
(verified nesting depth 2, announced max depth 5; see
[#2870](https://github.com/dsj1984/mandrel/issues/2870)), so the same
one-objective / verify / parallelize policy applies **at every level** —
substitute "orchestrator" for "main agent" and "child" for "subagent"
throughout and the rules hold unchanged. Keeping a given dispatch level
flat remains a legitimate **design choice** (e.g. the `/deliver` wave
loop), but it is no longer forced by a harness limitation.

The cost caution compounds with depth: every nesting level re-pays the
full always-loaded context, so an orchestrator MUST weigh the depth it
opens against its budget (see
[`instructions.md` § 4](../../../../instructions.md)) and stay within the
supported depth envelope.

## Policy Capsule

- Dispatch one objective per subagent; never bundle unrelated goals into a single delegation.
- Hand each subagent only the minimum context (files, docs, goal) required — no broad context dumps.
- Specify the expected return format explicitly (JSON summary, diff, bullet list) in every handoff.
- Verify the subagent's output before incorporating it; treat returned artifacts as untrusted until checked.
- Run non-dependent subagents in parallel; serialize only when one subagent's output is required input for another.
- Require a concise summary back from each subagent to keep the orchestrator's context window clean.
- Investigate subagent failures rather than retrying blindly with the same prompt.
- Respect the nesting depth budget; each level opened re-pays the always-loaded context, so orchestrate deeper only when the isolation or parallelism gain justifies the cost.

Internal protocol for managing complex tasks through the creation and
coordination of subagents, applied recursively by the orchestrator at any
supported depth.

## 1. Core Principles

- **Task Isolation:** One objective per subagent. Do not overload a subagent
  with multiple unrelated tasks.
- **Minimal Context:** Provide only the necessary context (files, docs, specific
  goal) to keep the subagent focused and token-efficient.
- **Verification:** The orchestrator must always verify each child's output
  before incorporating it into its own result — at every level of the tree.
- **Depth Awareness:** Orchestration is recursive; before opening a deeper
  level, confirm the work justifies re-paying the always-loaded context and
  that the nesting stays within the supported depth envelope.

## 2. Operation Standards

- **Handoffs:** When delegating, clearly state the expected return format (e.g.,
  "Return a JSON summary", "Provide a diff for file X").
- **Error Handling:** If a subagent fails or returns an ambiguous result,
  investigate the failure rather than retrying blindly.
- **Parallelism:** Use subagents to perform non-dependent tasks concurrently
  (e.g., auditing three different modules simultaneously). A child that is
  itself an orchestrator may parallelize its own sub-units the same way.

## 3. Best Practices

- **State Sync:** Ensure the orchestrator's mental model remains the source of
  truth if multiple subagents modify the codebase.
- **Summarization:** Require subagents to provide a concise summary of their
  findings to prevent the orchestrator's context window from being flooded.
