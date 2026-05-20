---
name: turso-sqlite
description:
  Develops with Turso's distributed SQLite (libSQL) platform. Use when working
  with the `@libsql/client` driver — leverage edge replicas for low-latency
  reads, route writes to the primary, and use parameterized queries plus a
  versioned migration tool (drizzle-kit, atlas) for schema changes.
vendor: turso
---

# Skill: Turso (SQLite)

## Policy Capsule

- Use the `@libsql/client` driver for all database operations; do not mix in other SQLite clients.
- Always use parameterized queries (`?` or `:name`); never interpolate user input into SQL strings.
- Route reads to the nearest edge replica and writes to the primary; do not write to a replica.
- Manage schema changes through a versioned migration tool (`drizzle-kit`, `atlas`) checked into git; never hand-mutate production schema.
- Reuse the libSQL client instance within a worker invocation to avoid repeated handshake overhead.
- Audit slow queries with `EXPLAIN QUERY PLAN` and add indexes where the plan shows a full scan on a large table.

Rules for developing with Turso's distributed SQLite database platform.

## 1. Core Principles

- **Edge Efficiency:** Leverage Turso's low-latency distribution for edge
  applications.
- **SQLite Simplicity:** Use standard SQL syntax. SQLite is powerful—don't
  over-engineer with complex ORMs unless necessary.
- **Replication:** Understand the primary/replica architecture for
  geographically distributed workloads.

## 2. Technical Standards

- **Driver Usage:** Use the `@libsql/client` driver for all database operations.
- **Parameterized Queries:** Never use string interpolation for queries. Always
  use placeholders (`?` or `:name`) to prevent SQL injection.
- **Migrations:** Use a structured migration tool (e.g., `drizzle-kit` or
  `atlas`) to manage schema changes versioned in git.

## 3. Best Practices

- **Connection Management:** Reuse database client instances within a worker
  invocation to minimize handshake overhead.
- **Read-Local, Write-Primary:** Direct read operations to the nearest replica
  and write operations to the primary instance.
- **Profiling:** Use `EXPLAIN QUERY PLAN` to audit slow queries and ensure
  proper indexing of large tables.
