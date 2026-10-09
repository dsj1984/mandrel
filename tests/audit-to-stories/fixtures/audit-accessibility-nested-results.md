# Accessibility Audit Report

## Executive Summary

The review covered the checkout flow against WCAG 2.2 AA. Findings are grouped
by POUR principle; each principle heading is a grouping header, not a finding.

Self-cross-check: kept 3 / dropped 1.
Severity tally: Critical 0 / High 1 / Medium 1 / Low 1

## Detailed Findings

### Perceivable

#### `src/components/CheckoutSummary.jsx` — Order total announced only by colour

- **Dimension:** Perceivable
- **Severity:** High
- **Location:** `src/components/CheckoutSummary.jsx:64`
- **Current State:** The discounted total in `src/components/CheckoutSummary.jsx` is distinguished from the original only by a red text colour, with no text or `aria-label` alternative, so a screen-reader user hears two identical currency amounts.
- **Recommendation & Rationale:** Add a visually-hidden "discounted total" label beside the amount and keep the colour as reinforcement, satisfying WCAG 1.4.1 Use of Colour.
- **Acceptance signal:** An axe-core run over the checkout route reports zero `color-contrast` / `use-of-colour` violations.

#### `src/components/PromoBanner.jsx` — Decorative banner exposed to assistive tech

- **Dimension:** Perceivable
- **Severity:** Low
- **Location:** `src/components/PromoBanner.jsx:12`
- **Current State:** The decorative promotional image in `src/components/PromoBanner.jsx` carries a descriptive `alt` string repeating the adjacent heading, so the heading is announced twice.
- **Recommendation & Rationale:** Mark the image decorative with `alt=""` so assistive tech skips it, per WCAG 1.1.1.
- **Acceptance signal:** A DOM assertion that the banner image exposes an empty accessible name.

### Operable

#### `src/components/AddressForm.jsx` — Focus is not moved to the validation summary

- **Dimension:** Operable
- **Severity:** Medium
- **Location:** `src/components/AddressForm.jsx:118`
- **Current State:** On a failed submit, `src/components/AddressForm.jsx` renders an error summary but leaves focus on the submit button, so keyboard and screen-reader users are not told the submit failed.
- **Recommendation & Rationale:** Move focus to the error summary container (`tabindex="-1"`) after a failed submit, satisfying WCAG 3.3.1.
- **Acceptance signal:** A component test asserting `document.activeElement` is the error summary after a rejected submit.
