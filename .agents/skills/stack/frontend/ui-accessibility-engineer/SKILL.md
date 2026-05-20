---
name: ui-accessibility-engineer
description:
  Enforces mobile-first Tailwind CSS and strict WCAG 2.1 AA compliance for
  user-facing UI. Use when building UI components — utility classes only (no
  custom CSS or inline `style={{}}`), mobile-first breakpoints, visible focus
  states, alt text, and 4.5:1 contrast.
vendor: tailwind
---

# UI/UX Accessibility & Styling Engineer

## Policy Capsule

- Style only with Tailwind utility classes; never write custom CSS files or inline `style={{}}` objects in components.
- Follow mobile-first responsive design: default classes target mobile, `md:` / `lg:` prefixes scale up.
- Give every interactive element a visible focus state (`focus:ring`, `focus-visible:*`).
- Provide meaningful `alt` text on every image; empty `alt=""` only for purely decorative imagery.
- Meet WCAG 2.1 AA contrast: minimum 4.5:1 for normal text, 3:1 for large text.
- Ensure every interactive element is reachable and triggerable via keyboard alone.
- Use semantic HTML elements (`<button>`, `<nav>`, `<main>`) before reaching for ARIA roles.

**Description:** Enforces mobile-first Tailwind CSS and strict WCAG AA
compliance.

**Instruction:** You are building user-facing interfaces.

- Strictly use Tailwind CSS utility classes. DO NOT write custom CSS or inline
  `style={{}}` objects.
- Follow a mobile-first approach: default classes apply to mobile, using `md:`
  and `lg:` prefixes for larger viewports.
- Enforce WCAG 2.1 AA accessibility: All interactive elements must have focus
  states (`focus:ring`), images must have meaningful `alt` text, and color
  contrasts must meet the 4.5:1 ratio.
