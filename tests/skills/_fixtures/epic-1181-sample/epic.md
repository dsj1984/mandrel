# Epic 9999 — Sample Epic Body for Smoke Tests

This is a minimal Epic body used by the planning-Skill smoke tests. The
text is intentionally short and free of placeholders so the planning
Skills can author a PRD and Tech Spec without external context.

## Problem

The framework needs a representative Epic body for smoke fixtures so the
planning Skills (`epic-plan-spec-author`, `epic-plan-decompose-author`)
can be exercised end-to-end against a known input without hitting a live
GitHub Epic.

## Goals

- Provide a stable input that the smoke harness can hash if it ever needs
  to detect drift.
- Cover at least one feature surface so the decomposer can produce a
  non-trivial ticket hierarchy.

## Out of scope

- Real Feature/Story IDs (the smoke validator never persists tickets).
