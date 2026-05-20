---
name: astro
description:
  Builds ultra-fast content-driven websites with Astro. Use when defaulting to
  SSG, opting into SSR only for dynamic data, picking the most restrictive
  `client:*` hydration directive, leveraging Server Islands (`server:defer`),
  Astro Actions for type-safe mutations, and the Content Layer with Zod-
  validated collections.
vendor: astro
---

# Skill: Astro (Iron)

## Policy Capsule

- Default to SSG; opt into SSR only when a route requires per-request dynamic data.
- Ship zero JS by default — `.astro` components must not bundle client JavaScript unless a `client:*` directive is set explicitly.
- For personalized or dynamic islands, prefer `server:defer` (Server Islands) over shipping a fully hydrated client island.
- Use the most restrictive hydration directive that meets the interaction: `client:load` only for immediate interactivity, `client:visible` for below-the-fold, `client:idle` for non-critical logic.
- Handle data mutations and form submissions through Astro Actions, not ad-hoc fetch handlers, to preserve type safety.
- Source content through the Content Layer API with Zod-validated collections in `src/content/config.ts`.
- Use the built-in `<Image />` and `<Picture />` components for image optimization rather than raw `<img>` tags.
- Inject SEO metadata (`title`, `meta`, `og:image`, `canonical`) from a shared layout component.

Guidelines and best practices for building ultra-fast content-driven websites
using Astro.

## 1. Core Principles

- **Static First:** Default to SSG (Static Site Generation). Use SSR only when
  dynamic user data or real-time interaction is required.
- **Island Architecture:** Use standard HTML for most of the page.
- **Server Islands (Astro 5):** Use the `server:defer` directive for components
  that depend on personalized or dynamic data.
- **Astro Actions:** Use built-in Actions for all data mutations and form
  submissions to ensure type-safety.
- **Zero JS by Default:** Ensure components use `.astro` syntax and do not ship
  any JavaScript to the client unless explicitly requested via `client:*`
  directives.

## 2. Technical Standards

- **Component Structure:**
  - Logic (JS/TS) in the component script (top `---` fence).
  - Markup in the HTML template.
  - Scoped CSS in the `<style>` block.
- **Content Layer API:** Always use the new Content Layer for data sourcing.
  Manage collections via `src/content/config.ts` with Zod schema validation for
  all metadata.
- **Hydration Directives:** Use the most restrictive directive possible:
  - `client:load` for immediate interactivity.
  - `client:visible` for elements below the fold.
  - `client:idle` for non-critical logic.

## 3. Best Practices

- **Image Optimization:** Always use the `<Image />` or `<Picture />` components
  for automatic format conversion and resizing.
- **Metadata/SEO:** Use a layout component to inject standard SEO tags (`title`,
  `meta`, `og:image`, `canonical`).
- **View Transitions:** Use Astro's built-in view transitions for SPA-like
  navigation without the performance overhead.
