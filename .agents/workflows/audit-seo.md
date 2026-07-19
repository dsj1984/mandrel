---
description: Audit SEO fundamentals and Generative Engine Optimization signals (meta, structured data, crawlability); only relevant for web targets.
---

# SEO & Generative Engine Optimization Audit

## Applicability

**Web targets only.** This lens is registered with `target: "web"` in
[`audit-rules.json`](../schemas/audit-rules.json), so the selector skips it
entirely on a project with no web surface — however well its keyword triggers
match the ticket prose. Applicability is derived from the consumer's own
checkout (configured navigability `routeGlobs`, a declared web-framework
dependency, or a tracked `.html` / `.css` / `.jsx` / `.tsx` source file), not
from an `.agentrc` key, and the probe fails open when indeterminate.

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

## Scope (Story / plan-run mode)

When this lens is invoked from `/deliver` close lenses (or a plan-run audit), the
following block is populated with the Story (or plan-run) change-set file list.
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

## Step 0: Indexability gate (run first)

**Open every SEO audit by deciding whether the surface is meant to be indexed at
all.** SEO findings on an auth-walled, private, or internal surface are noise —
a login-gated dashboard is *supposed* to be invisible to crawlers, so a missing
`<meta name="description">` there is not a defect.

- **Auth-walled / private surface** (every route under the change set sits
  behind an authentication guard, a `noindex` directive, or a `Disallow`-all
  `robots.txt`) ⇒ record a single **"SEO not applicable — surface is not
  indexable"** note and stop. Do not emit per-file findings.
- **Publicly indexable surface** (marketing pages, docs, blog, product pages, a
  public app shell) ⇒ proceed to Step 1.
- **Mixed** ⇒ scope the remaining steps to the indexable routes only, and say so
  in the Executive Summary.

## Step 1: Framework-aware metadata detection matrix

> Apply [`helpers/parallel-tooling.md`](helpers/parallel-tooling.md) when batching the scan below — independent reads belong in one turn, long shells run via `run_in_background` + `Monitor`.

Modern web consumers almost never ship literal `<head><meta></head>` HTML — the
metadata is produced by a framework mechanism. **Identify the mechanism first,
then probe the surfaces that mechanism uses.** Reporting "no `<meta>` tags found"
on a Next.js app that sets them through `generateMetadata` is a false finding.

- **Step 1a — Identify the meta mechanism.** Determine which one (or more) of the
  following the consumer uses, from its dependencies and source layout:

  | Framework / library | Metadata mechanism | Where to probe |
  | --- | --- | --- |
  | Next.js (App Router) | `metadata` export / `generateMetadata()` | `app/**/{layout,page}.{js,jsx,ts,tsx}` |
  | Next.js (Pages Router) | `next/head` `<Head>` | `pages/**/*.{js,jsx,ts,tsx}` |
  | React (generic) | `react-helmet` / `react-helmet-async` | components importing `Helmet` |
  | Vue / Nuxt | `@unhead/vue` / `useHead()` / `nuxt.config` `head` | `*.vue`, `nuxt.config.*` |
  | Svelte / SvelteKit | `<svelte:head>` | `*.svelte` |
  | Astro | frontmatter `<head>` in layouts | `*.astro` |
  | Plain static | literal `<head>` HTML | `*.html` |

- **Step 1b — Enumerate the routes.** Take the route list from the navigability
  `routeGlobs` SSOT (the same route tree the navigability lens enumerates), not
  from a guess. Each public route is a page whose metadata you assess.
- **Step 1c — Per-route metadata probe.** For each indexable route, assert the
  detected mechanism supplies: a `<title>`, a meta description, canonical URL,
  Open Graph / Twitter Card tags, and (where relevant) JSON-LD structured data.
  A route whose mechanism sets none of these is a real finding.

## Step 2: Analysis Dimensions

Evaluate the gathered context against the following dimensions:

1. **Traditional SEO:** Meta mechanism coverage (per Step 1), semantic structure,
   heading hierarchy, `<img alt>`, internal linking logic, and canonical URLs.
2. **AIO & GEO (Answer Engine Optimization):** Entity clarity, concise answer
   formatting, structured data (Schema.org), and token efficiency for LLM
   retrieval.
3. **Statically-provable Core Web Vitals defects only:** flag *code-visible*
   regressions — unsized images or media embeds (CLS risk), render-blocking synchronous
   scripts, and fonts loaded without `display=swap`. **Do not estimate or score
   measured CWV** (LCP/INP/CLS numbers): measured Core Web Vitals are owned by
   the `audit-performance` lens — defer them there explicitly rather than
   guessing a score from source.
4. **Crawlability:** `robots.txt`, `sitemap.xml` (including generated
   `sitemap.*`/`robots.*` route handlers), and any `noindex` directives that may
   unintentionally block indexable pages.

## Step 3: Output Requirements

Generate and save a highly structured Markdown audit report to
`{{auditOutputDir}}/audit-seo-results.md`, using the exact template below.

> Grade every finding's severity on the shared
> [`Critical | High | Medium | Low` scale](helpers/audit-severity-scale.md).

```markdown
# SEO & GEO Audit Report

## Executive Summary

[A high-level view of the site's current optimization health, highlighting the
primary gaps and the most impactful opportunities.]

## Detailed Audit Table

[A supplementary at-a-glance index only. Every row MUST also have a full
`## Detailed Findings` entry below — the Detailed Findings blocks are the
machine-parsed source of record; this table is not parsed.]

| Issue               | Impact                      | Category   | Suggested Fix |
| ------------------- | --------------------------- | ---------- | ------------- |
| [Issue description] | Critical / High / Med / Low | SEO or GEO | [Brief fix]   |

## GEO-Specific Recommendations

[Specific advice on how to make this codebase more readable for AI models —
e.g., adding specific Schema types, flattening nested DOM structures, or
reformatting key content as FAQ blocks.]

## Detailed Findings

[Mandatory: emit one entry per issue in the Detailed Audit Table above, using
the following strict structure. Lead each title with the primary file the
finding lives in:]

### `path/to/primary-file.ext` — [Short title of the issue]

- **Category:** [SEO | GEO | Core Web Vitals | Crawlability]
- **Impact:** [Critical | High | Medium | Low]
- **Location:** `path/to/primary-file.ext:line`
- **Current State:** [What exists in the codebase and why it's suboptimal]
- **Recommendation & Rationale:** [The specific fix and how it improves
  discoverability or LLM retrieval]
- **Acceptance signal:** [the command or observable that proves this finding is remediated — e.g. the meta tag now present in the rendered head, or a re-run of this lens]
- **Agent Prompt:**
  `[A copy-pasteable, highly specific prompt to execute this fix independently]`
```

---

## Constraint

Do NOT rewrite or modify any files. Do NOT implement the changes. Focus strictly
on analyzing the code. Output the report and stop.

## Self-cross-check (mandatory — filter false positives before you finalize)

Before you write the report artifact from the previous step, run the shared
adversarial self-cross-check over your Detailed Findings — see
[`helpers/audit-self-check.md`](helpers/audit-self-check.md). It defines the
per-finding evidence bar, the exclusion list, and the final re-open-and-drop
pass whose `kept <k> / dropped <d>` counts you record in the Executive
Summary, so the sequential single-pass path filters unverified findings just as
the orchestrated path's adversarial reviewer does.
