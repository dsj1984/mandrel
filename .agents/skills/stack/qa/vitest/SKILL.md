---
name: vitest
description:
  Writes fast, isolated unit and integration tests with Vitest. Use when each
  test must run on file-save without shared state — `vi.mock()` for external
  deps, `vi.spyOn()` for call monitoring, AAA structure, and edge-case
  coverage for null/undefined/boundary inputs.
vendor: vitest
---

# Skill: Vitest

## Policy Capsule

- Keep each test independent — never share mutable state between tests; reset mocks in `afterEach`.
- Mock external dependencies with `vi.mock()`; use `vi.spyOn()` only to observe call shape, not to replace logic.
- Structure tests as Arrange / Act / Assert — do not interleave the three phases.
- Use descriptive titles in the `describe('Component', () => { it('should [action] when [condition]') })` form.
- Cover error paths, null/undefined inputs, and boundary conditions, not just the happy path.
- Use snapshots only for large, stable data structures; avoid them for frequently changing UI to prevent snapshot fatigue.
- Aim for 80%+ coverage on business logic and edge cases; audit with `vitest --coverage`.
- Test observable behavior, not internal implementation details; refactors should not require rewriting passing tests.
