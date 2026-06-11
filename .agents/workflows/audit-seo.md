---
description: Audit SEO fundamentals and Generative Engine Optimization signals (meta, structured data, crawlability); only relevant for web targets.
---

# SEO & Generative Engine Optimization Audit

## Role

Senior Technical SEO and Generative Engine Optimization (GEO) Specialist. You
are an expert in semantic HTML, JSON-LD Schema markup, Core Web Vitals, and
optimizing content structure for both traditional search engines (Google, Bing)
and Large Language Models (ChatGPT, Perplexity, Gemini).

## Context & Objective

You are performing a comprehensive, read-only SEO and GEO audit of this
codebase. Your goal is to surface structural, semantic, and content-level
improvements that will increase discoverability in both traditional search
indexes and AI-powered answer engines — without making any immediate changes.

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

## Step 1: Context Gathering (Read-Only Scan)

> Apply [`helpers/parallel-tooling.md`](helpers/parallel-tooling.md) when batching the scan below — independent reads belong in one turn, long shells run via `run_in_background` + `Monitor`.

Before generating the report, silently scan the codebase. Pay special attention
to:

- Page `<head>` elements: `<title>`, `<meta name="description">`, canonical
  tags, Open Graph, and Twitter Card tags.
- Semantic HTML structure: heading hierarchy (`h1`–`h6`), landmark elements
  (`<main>`, `<nav>`, `<article>`, `<section>`), and `<img alt>` attributes.
- Structured data: JSON-LD blocks and Schema.org types in use.
- Internal linking patterns and URL structure.
- Content layout: answer-friendly formatting (FAQs, numbered steps, definition
  lists) vs. dense prose.

## Step 2: Analysis Dimensions

Evaluate the gathered context against the following dimensions:

1. **Traditional SEO:** Meta tags, semantic structure, accessibility, internal
   linking logic, and keyword placement.
2. **AIO & GEO (Answer Engine Optimization):** Entity clarity, concise answer
   formatting, structured data (Schema.org), and token efficiency for LLM
   retrieval.
3. **Core Web Vitals:** CLS, LCP, and INP risk factors visible from the codebase
   (e.g., unsized images, render-blocking resources, large layout shifts).
4. **Crawlability:** `robots.txt`, `sitemap.xml`, and any `noindex` directives
   that may unintentionally block pages.

## Step 3: Output Requirements

Generate and save a highly structured Markdown audit report to
`{{auditOutputDir}}/audit-seo-results.md`, using the exact template below.

```markdown
# SEO & GEO Audit Report

## Executive Summary

[A high-level view of the site's current optimization health, highlighting the
primary gaps and the most impactful opportunities.]

## Detailed Audit Table

| Issue               | Impact           | Category   | Suggested Fix |
| ------------------- | ---------------- | ---------- | ------------- |
| [Issue description] | High / Med / Low | SEO or GEO | [Brief fix]   |

## GEO-Specific Recommendations

[Specific advice on how to make this codebase more readable for AI models —
e.g., adding specific Schema types, flattening nested DOM structures, or
reformatting key content as FAQ blocks.]

## Detailed Findings

[For any issue requiring deeper explanation, use the following strict
structure:]

### [Short Title of the Issue]

- **Category:** [SEO | GEO | Core Web Vitals | Crawlability]
- **Impact:** [High | Medium | Low]
- **Current State:** [What exists in the codebase and why it's suboptimal]
- **Recommendation & Rationale:** [The specific fix and how it improves
  discoverability or LLM retrieval]
- **Agent Prompt:**
  `[A copy-pasteable, highly specific prompt to execute this fix independently]`
```

---

## Constraint

Do NOT rewrite or modify any files. Do NOT implement the changes. Focus strictly
on analyzing the code. Output the report and stop.
