---
description: Audit UX/UI consistency and design system adherence
---

# UX/UI & Design System Audit

## Role

Lead Product Designer & Frontend Architect

## Context & Objective

Evaluate the frontend implementation for UI consistency, UX best practices, and
adherence to the project's design system. Ensure the application feels premium
and cohesive.

## Scope (Epic mode)

When this lens is invoked from `/deliver` Phase 4 (epic-audit), the
following block is populated with the Epic's change-set file list.
Otherwise — for any manual `/audit-<dimension>` invocation — the block
renders the literal substitution token and you MUST treat it as **no
scope filter — run the lens codebase-wide** exactly as you would have
before this section existed.

```text
{{changedFiles}}
```

- If the block above contains a newline-delimited list of file paths,
  restrict your analysis to those files (and their direct dependencies
  when the lens explicitly calls for cross-file reasoning).
- If the block above renders as the literal string `{{changedFiles}}`
  (i.e. no substitution was supplied), ignore this section entirely and
  proceed with the full codebase-wide scan defined in the remaining
  steps.

## Step 1: Visual Consistency Check

> Apply [`helpers/parallel-tooling.md`](helpers/parallel-tooling.md) when batching the scan below — independent reads belong in one turn, long shells run via `run_in_background` + `Monitor`.

Scan frontend components for:

- **Hardcoded Values:** Identify "magic" hex codes, font sizes, or spacing
  values that bypass the CSS variables/design tokens.
- **Component Re-implementation:** Find places where custom HTML/CSS is used
  instead of the standard component library (e.g., custom button instead of
  `<Button />`).
- **Interactive States:** Verify that all clickable elements have hover, focus,
  and active states.
- **Typography:** Ensure font families and weights are used consistently
  according to the hierarchy.

## Step 2: UX Best Practices

1. **Information Hierarchy:** Is the most important action/information
   prominent?
2. **Error States:** Are form errors clear and helpful, or generic and
   frustrating?
3. **Loading States:** Are there skeletons or spinners for async operations?
4. **Responsiveness:** Check layouts at mobile, tablet, and desktop breakpoints.
5. **Accessibility (UX-focused):** Focus on tab order, touch target sizes, and
   color contrast.

## Step 3: Output Requirements

Generate and save a highly structured Markdown audit report to
`{{auditOutputDir}}/audit-ux-ui-results.md`, using the exact template below.

```markdown
# UX/UI & Design System Audit report

## Executive Summary

[Overview of design system health (Score 1-10) and adherence to
tokens/components.]

## Detailed Findings

[For every inconsistency or UX improvement identified, use the following strict
structure:]

### [Short Title of the Issue]

- **Dimension:** [e.g., Visual Consistency | UX Best Practices | Accessibility]
- **Impact:** [High | Medium | Low]
- **Current State:** [What is currently implemented and why it is sub-optimal]
- **Recommendation & Rationale:** [The specific UI/UX change and how it improves
  premium feel or usability]
- **Agent Prompt:**
  `[A copy-pasteable, highly specific prompt to execute this UI change independently]`

## Micro-animation Opportunities

- [Suggest 2-3 places where subtle transitions could enhance the "premium"
  feel.]
```

## Constraint

This is a **read-only** audit. Provide the critique and implementation
suggestions, but do not modify styles or components.
