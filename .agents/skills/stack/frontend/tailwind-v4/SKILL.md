---
name: tailwind-v4
description:
  Implements maintainable styling with Tailwind CSS v4. Use when writing
  styles in v4 projects — CSS-first configuration via `@theme` blocks (never
  `tailwind.config.ts/js`), mobile-first breakpoints, full class names (no
  string interpolation), and no arbitrary `p-[13px]`-style values.
vendor: tailwind
---

# Skill: Tailwind CSS v4

## Policy Capsule

- Configure the theme via CSS-first `@theme` blocks; never use `tailwind.config.ts` or `tailwind.config.js` in v4 projects.
- Prefer atomic utility classes (`flex`, `p-4`, `text-lg`) over hand-written CSS classes.
- Use mobile-first breakpoints (`sm:`, `md:`, `lg:`, `xl:`); never write desktop-first overrides.
- Define `hover:`, `focus-visible:`, and `active:` states explicitly on every interactive element.
- Arbitrary values (`p-[13px]`) are prohibited — map one-off values to a `@theme` CSS variable instead.
- Never build utility classes by string interpolation (e.g. `text-${color}`); always use full literal class names so the compiler detects them.
- Adhere to the design system's spacing, color, and typography tokens defined in `@theme` variables.
- For repeated UI patterns, extract a component or a CSS `@apply` block — do not let class strings bloat in JSX.

Rules for implementing high-performance, maintainable styling using the latest
Tailwind CSS specification.

## 1. Core Principles

- **CSS-First Configuration:** Use CSS variables for theme customization within
  the `@theme` block. **NEVER** use `tailwind.config.ts` or `tailwind.config.js`
  in v4 projects.
- **Modern Syntax:** Leverage the new `@theme` directive, fluid design
  utilities, and lightning-fast compilation.
- **Token Consistency:** Strictly adhere to the design system's spacing, color,
  and typography tokens defined in the CSS variables.

## 2. Technical Standards

- **Utility Usage:** Prefer atomic utility classes (`flex`, `p-4`, `text-lg`)
  over custom CSS classes.
- **Responsive Design:** Use mobile-first breakpoints (`sm:`, `md:`, `lg:`,
  `xl:`).
- **Interactive States:** Explicitly define `hover:`, `focus-visible:`, and
  `active:` states for all interactive elements to ensure a premium feel.
- **Arbitrary Values:** **STRICTLY PROHIBITED** (`p-[13px]`) unless explicitly
  required by a one-off legacy asset. Always map unique values to a temporary
  CSS variable in the `@theme` block instead.

## 3. Best Practices

- **Class Ordering:** Use the standard Tailwind class ordering (Layout -> Box
  Model -> Typography -> Visual -> Misc).
- **Component Patterns:** For repeated UI patterns (e.g., buttons), use a
  dedicated component or a reusable `@apply` block in a CSS file to avoid
  class-string bloat.
- **Dynamic Classes:** Never use string interpolation to create utility classes
  (e.g., `text-${color}`). Always use full class names to ensure the compiler
  detects them.
