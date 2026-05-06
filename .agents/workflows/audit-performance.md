---
description: Run a performance and bottleneck audit
---

# Performance & Bottleneck Audit

## Role

Performance Engineer & Systems Architect

## Context & Objective

Analyze the application for performance regressions, bottlenecks, and efficiency
gaps. Your goal is to identify why a system is slow or where it might fail under
load.

## Step 1: Bottleneck Discovery

Investigate the following areas:

- **Database/API Efficiency:** Look for N+1 query patterns, missing indexes, or
  oversized JSON payloads.
- **Frontend Rendering:** Identify unnecessary re-renders (in React/Vue), large
  DOM trees, or layout thrashing.
- **Bundle Size:** Check for heavy dependencies, missing code-splitting, or
  unoptimized assets.
- **Resource Usage:** Identify potential memory leaks or high CPU usage logic
  (e.g., synchronous loops over large datasets).
- **Network Path:** Check for excessive round-trips or lack of caching headers.

## Step 2: Evaluation Dimensions

1. **Latency:** How long does it take for a user action to complete?
2. **Throughput:** How many concurrent operations can the system handle before
   degrading?
3. **Efficiency:** Is the code using the minimum amount of CPU/Memory/Network
   required?
4. **Scalability:** Does the performance hold as the data size or user count
   increases?
5. **Core Web Vitals:** (For frontend) LCP, FID, and CLS metrics.

## Step 3: Output Requirements

Generate and save a highly structured Markdown audit report to
`{{auditOutputDir}}/audit-performance-results.md`, using the exact template
below.

```markdown
# Performance Audit Report

## Executive Summary

[Overview of performance summary vs target benchmarks.]

## Detailed Findings

[For every bottleneck identified, use the following strict structure:]

### [Short Title of the Bottleneck]

- **Dimension:** [e.g., Latency | Throughput | Efficiency]
- **Impact:** [High | Medium | Low]
- **Current State:** [Technical explanation of where and why the bottleneck
  occurs]
- **Recommendation & Rationale:** [Specific optimization tactic and expected
  performance gain]
- **Agent Prompt:**
  `[A copy-pasteable, highly specific prompt to execute this optimization independently]`

## Low-Hanging Fruit

- [List 3 quick changes that provide immediate performance gains.]
```

## Constraint

This is a **read-only** audit. Note: This workflow differs from
`audit-lighthouse.md` (which runs Lighthouse and reports per-category scores
and findings) by focusing on deep architectural and logic bottlenecks across
the whole stack — backend, data access, and runtime hot paths — rather than
the page-load surface Lighthouse measures.
