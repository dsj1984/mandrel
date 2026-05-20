---
name: cloudflare-hono-architect
description:
  Prevents Node.js module hallucinations in Cloudflare Worker (V8 isolate)
  edge environments. Use when writing Hono routes deployed to Workers — prefer
  Web APIs (Fetch, Web Crypto) over Node built-ins (`fs`, `path`,
  `child_process`, `crypto`), and access bindings via Hono's `c.env`.
vendor: cloudflare
---

# Cloudflare Worker & Hono Architect

## Policy Capsule

- Never import Node.js built-ins (`fs`, `path`, `child_process`, Node's `crypto`) in Worker code — they do not exist in the V8 isolate runtime.
- Use the Web Crypto API for hashing, signing, and random bytes; do not reach for `node:crypto`.
- Access bindings (env vars, R2 buckets, KV, Queues, D1) only through Hono's context (`c.env`), never through `process.env`.
- Prefer Web platform APIs (`fetch`, `Request`, `Response`, `URLPattern`) over Node-flavored equivalents.
- Treat any import that resolves to a Node-only polyfill as a hallucination — surface and remove it.

**Description:** Prevents Node.js module hallucinations in edge environments.

**Instruction:** The API is built with Hono and deployed to Cloudflare Workers
(V8 Isolates).

- YOU MUST NOT use standard Node.js built-ins (e.g., `fs`, `path`,
  `child_process`).
- If cryptography is needed, use the standard Web Crypto API, not Node's
  `crypto`.
- Access all environment variables, R2 buckets, and Queues strictly through the
  Hono Context bindings (`c.env`).
