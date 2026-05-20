---
name: cloudflare-workers
description:
  Builds and deploys high-performance edge logic on Cloudflare Workers. Use
  when working within Workers' 128MB memory and 5–50ms CPU constraints,
  integrating KV/R2/D1 storage, or writing Wrangler-managed edge-first
  request/response code.
vendor: cloudflare
---

# Skill: Cloudflare Workers

## Policy Capsule

- Respect the Worker resource envelope: 128MB memory and 5–50ms CPU per invocation; design code paths to fit inside it.
- Configure and deploy via Wrangler; do not hand-roll deployment scripts.
- Pick the right storage primitive: KV for simple key-value, R2 for object storage, D1 for relational data.
- Use the standard Fetch API for outgoing HTTP; never reach for Node-flavored HTTP clients.
- Store secrets with `wrangler secret`; never commit secrets to source.
- Minimize sub-requests per invocation to stay under platform limits.
- Stream large payloads via `TransformStream`; never buffer them entirely into memory.
- Install a global error handler so a single failing request does not take down the worker.

Guidelines for building and deploying high-performance serverless logic at the
edge.

## 1. Core Principles

- **Edge First:** Run code as close to the user as possible.
- **Resource Constraints:** Be mindful of the 128MB memory limit and the strict
  CPU time limits (e.g., 5-50ms) for workers.
- **Cold Starts:** Workers have near-zero cold starts, but external resource
  initialization must be optimized.

## 2. Technical Standards

- **Routing:** Use `Wrangler` for configuration and local development.
- **Storage Integration:** Use `KV` for simple key-value needs, `R2` for object
  storage, and `D1` for relational data.
- **Fetch API:** Always use the standard Fetch API for outgoing network
  requests.
- **Security:** Use `wrangler secret` for environment variables and API keys.

## 3. Best Practices

- **Sub-requests:** Minimize the number of sub-requests per worker invocation to
  stay within limits.
- **Streaming:** Use the `TransformStream` API for processing large payloads
  without loading everything into memory.
- **Error Handling:** Implement robust global error handlers to prevent total
  worker failure on a single request error.
