---
name: astro-react-island-strategist
description:
  Maintains strict boundaries between Astro server components and React client
  islands in hybrid Astro/React workspaces. Use when keeping `.astro` files
  for static HTML/SEO and `.tsx` for interactive islands — embed React only
  with explicit `client:*` directives and pass serializable props.
vendor: astro
---

# Astro & React Island Strategist

## Policy Capsule

- Use `.astro` files for static HTML generation, routing, and SEO; do not reach for React when Astro suffices.
- Use React `.tsx` files only for genuinely interactive UI islands, not for static rendering.
- Embed a React component in Astro only with an explicit `client:*` directive (`client:load`, `client:idle`, `client:visible`).
- Pick the most restrictive `client:*` directive that satisfies the interaction — prefer `client:idle` or `client:visible` over `client:load` whenever possible.
- Pass only serializable data as props across the Astro → React island boundary; never pass functions or class instances.

**Description:** Maintains strict boundaries between Astro server components and
React client islands.

**Instruction:** For the `@repo/web` workspace:

- Use `.astro` files strictly for static HTML generation, routing, and SEO.
- Use React `.tsx` files ONLY for highly interactive UI components (islands).
- When embedding a React component in an Astro file, you MUST explicitly use
  client directives (e.g., `client:load` or `client:idle`).
- Only pass serializable data as props from Astro to React.
