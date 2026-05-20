---
name: cloudflare-queue-manager
description:
  Ensures idempotent and resilient background job execution on Cloudflare
  Queues. Use when writing consumer handlers — design for at-least-once
  delivery, wrap processing in try/catch with `message.retry()`, and order
  cascading deletes so the database row drops last.
vendor: cloudflare
---

# Cloudflare Queue Lifecycle Manager

## Policy Capsule

- Design every consumer handler to be idempotent; assume at-least-once delivery and treat duplicate messages as expected.
- Wrap message processing in `try/catch`; never let an unhandled throw kill the worker mid-batch.
- Use `message.retry()` for transient failures rather than crashing the whole consumer.
- For cascading deletions, delete third-party assets (Mux, R2, external APIs) first and the database row last to avoid orphans.
- Log each message ID and processing outcome so retried duplicates are traceable across replays.

**Description:** Ensures idempotent and resilient background job execution.

**Instruction:** You are writing consumer logic for Cloudflare Queues.

- Always assume messages can be delivered more than once; design all worker
  logic for strict idempotency.
- Wrap processing logic in `try/catch` blocks.
- If a sub-task fails (e.g., deleting a video from a third-party API), do NOT
  crash the whole worker. Log the error and use `message.retry()` strategically.
- For cascading deletions, ensure the database deletion happens LAST, only after
  third-party assets (Mux, R2) are confirmed deleted, to avoid orphaned data.
