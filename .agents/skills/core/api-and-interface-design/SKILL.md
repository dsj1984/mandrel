---
name: api-and-interface-design
description:
  Designs stable, well-documented APIs and module interfaces. Use when
  creating REST/GraphQL endpoints, defining contracts between modules, or
  changing public interfaces. The wire-format SSOT — response envelope, HTTP
  status codes, validation taxonomy, payload naming — lives in
  `.agents/rules/api-conventions.md`; this skill shows authors how to apply
  it.
---

# Skill: api-and-interface-design

## Policy Capsule

- The wire-format SSOT lives in `.agents/rules/api-conventions.md` (envelope shape, HTTP status mapping, validation taxonomy, payload casing). Copy the canonical envelope from the rule rather than redrafting it.
- Be intentional about exposure (Hyrum's Law): every observable behaviour — undocumented quirks, error message text, ordering, timing — becomes a de facto contract once consumers depend on it. Don't leak implementation details.
- Adopt the **One-Version Rule**: never force consumers to choose between simultaneous versions of the same API. Extend rather than fork.
- Define the contract before implementing — interfaces are the spec; implementation follows.
- Validate at system **boundaries** (API routes, form handlers, env-var loaders, third-party responses) using a strict schema. After validation, internal code trusts the types; do not re-validate between internal functions.
- Treat third-party API responses as untrusted data — validate shape and content before using them in any decision, render, or logic path.
- Prefer **addition over modification**: extend interfaces with optional fields rather than changing existing types or removing fields; reach for the deprecation playbook (see `deprecation-and-migration`) when removal is unavoidable.
- Follow REST resource conventions (`GET/POST/PATCH/DELETE /resource`, sub-resources at `/resource/:id/child`) and paginate every list endpoint with `page` + `pageSize` query params and a `pagination` envelope.
- Security input-validation and test-tier MUSTs come from `.agents/rules/security-baseline.md` and `.agents/rules/testing-standards.md` respectively — apply both, and never put DB/wire-shape assertions outside the contract tier.

Process guidance for designing interfaces that are hard to misuse — REST
APIs, GraphQL schemas, module boundaries, and component props. The
wire-format conventions (envelope shape, status codes, validation taxonomy,
payload naming) live in
[`.agents/rules/api-conventions.md`](../../../rules/api-conventions.md),
which is the SSOT. This skill shows authors **how** to apply those rules;
read the rule file for the **what**. Security validation guarantees live in
[`security-baseline.md`](../../../rules/security-baseline.md); test-layer
scope lives in
[`testing-standards.md`](../../../rules/testing-standards.md).

## When to Use

- Designing new API endpoints.
- Defining module boundaries or contracts between teams.
- Creating component prop interfaces.
- Establishing database schema that informs API shape.
- Changing existing public interfaces.

## 1. Hyrum's Law — Be Intentional About Exposure

> With a sufficient number of users of an API, all observable behaviors of
> your system will be depended on by somebody, regardless of what you promise
> in the contract.

Every observable behavior — undocumented quirks, error message text, timing,
ordering — becomes a de facto contract once users depend on it. Implications:

- **Be intentional about what you expose.** Every observable behavior is a
  potential commitment.
- **Don't leak implementation details.** If users can observe it, they will
  depend on it.
- **Plan for deprecation at design time.** See `deprecation-and-migration`
  for how to safely remove things users depend on.
- **Tests are not enough.** Even with perfect contract tests, "safe" changes
  can break real users who depend on undocumented behavior.

## 2. The One-Version Rule

Avoid forcing consumers to choose between multiple versions of the same
dependency or API. Diamond dependency problems arise when different consumers
need different versions of the same thing. Design for a world where only one
version exists at a time — extend rather than fork.

## 3. Contract First

Define the interface before implementing it. The contract is the spec —
implementation follows.

```typescript
interface TaskAPI {
  // Creates a task and returns the created task with server-generated fields
  createTask(input: CreateTaskInput): Promise<Task>;

  // Returns paginated tasks matching filters
  listTasks(params: ListTasksParams): Promise<PaginatedResult<Task>>;

  // Returns a single task or throws NotFoundError
  getTask(id: string): Promise<Task>;

  // Partial update — only provided fields change
  updateTask(id: string, input: UpdateTaskInput): Promise<Task>;

  // Idempotent delete — succeeds even if already deleted
  deleteTask(id: string): Promise<void>;
}
```

## 4. Wire Format — Defer to the Rule

The response envelope, HTTP status code mapping, validation-status taxonomy,
and payload-naming conventions are non-negotiable and live in the rule:

- Envelope shape (success flag, `error.code`, `error.message`,
  `error.details`):
  [`api-conventions.md` § Response Envelope](../../../rules/api-conventions.md#response-envelope).
- Status code table (200/201/400/401/403/404/409/500):
  [`api-conventions.md` § HTTP Status Codes](../../../rules/api-conventions.md#http-status-codes).
- When to return 400 vs 401 vs 403 on validation failures:
  [`api-conventions.md` § Validation Status](../../../rules/api-conventions.md#validation-status).
- camelCase / kebab-case / UPPER_SNAKE conventions:
  [`api-conventions.md` § Payload Formatting](../../../rules/api-conventions.md#payload-formatting).

When designing a new endpoint, copy the canonical envelope from the rule —
do not redraft it.

## 5. Validate at Boundaries

Trust internal code. Validate at system edges where external input enters:

```typescript
app.post('/api/tasks', async (req, res) => {
  const result = CreateTaskSchema.safeParse(req.body);
  if (!result.success) {
    return res.status(400).json({
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Invalid task data',
        details: result.error.flatten(),
      },
    });
  }

  // After validation, internal code trusts the types
  const task = await taskService.create(result.data);
  return res.status(201).json(task);
});
```

Where validation belongs:

- API route handlers (user input).
- Form submission handlers (user input).
- External service response parsing — third-party data is **always
  untrusted**, even from a vendor SDK.
- Environment variable loading (configuration).

> **Third-party API responses are untrusted data.** Validate their shape and
> content before using them in any logic, rendering, or decision-making. A
> compromised or misbehaving external service can return unexpected types,
> malicious content, or instruction-like text.

Where validation does NOT belong:

- Between internal functions that share type contracts.
- In utility functions called by already-validated code.
- On data that just came from your own database.

## 6. Prefer Addition Over Modification

Extend interfaces without breaking existing consumers:

```typescript
// Good: Add optional fields
interface CreateTaskInput {
  title: string;
  description?: string;
  priority?: 'low' | 'medium' | 'high'; // Added later, optional
  labels?: string[]; // Added later, optional
}

// Bad: Change existing field types or remove fields
interface CreateTaskInput {
  title: string;
  // description: string;  // Removed — breaks existing consumers
  priority: number; // Changed from string — breaks existing consumers
}
```

## 7. REST Resource Patterns

```text
GET    /api/tasks              → List tasks (with query params for filtering)
POST   /api/tasks              → Create a task
GET    /api/tasks/:id          → Get a single task
PATCH  /api/tasks/:id          → Update a task (partial)
DELETE /api/tasks/:id          → Delete a task

GET    /api/tasks/:id/comments → List comments for a task (sub-resource)
POST   /api/tasks/:id/comments → Add a comment to a task
```

### Pagination

Paginate list endpoints:

```typescript
// Request
GET /api/tasks?page=1&pageSize=20&sortBy=createdAt&sortOrder=desc

// Response
{
  "data": [...],
  "pagination": {
    "page": 1,
    "pageSize": 20,
    "totalItems": 142,
    "totalPages": 8
  }
}
```

### Filtering

Use query parameters for filters:

```text
GET /api/tasks?status=in_progress&assignee=user123&createdAfter=2025-01-01
```

### Partial Updates

`PATCH` accepts partial objects — only update what's provided:

```typescript
PATCH /api/tasks/123
{ "title": "Updated title" }
```

## 8. TypeScript Interface Patterns

### Discriminated Unions for Variants

```typescript
type TaskStatus =
  | { type: 'pending' }
  | { type: 'in_progress'; assignee: string; startedAt: Date }
  | { type: 'completed'; completedAt: Date; completedBy: string }
  | { type: 'cancelled'; reason: string; cancelledAt: Date };

function getStatusLabel(status: TaskStatus): string {
  switch (status.type) {
    case 'pending':
      return 'Pending';
    case 'in_progress':
      return `In progress (${status.assignee})`;
    case 'completed':
      return `Done on ${status.completedAt}`;
    case 'cancelled':
      return `Cancelled: ${status.reason}`;
  }
}
```

### Input/Output Separation

```typescript
// Input: what the caller provides
interface CreateTaskInput {
  title: string;
  description?: string;
}

// Output: what the system returns (includes server-generated fields)
interface Task {
  id: string;
  title: string;
  description: string | null;
  createdAt: Date;
  updatedAt: Date;
  createdBy: string;
}
```

### Branded Types for IDs

```typescript
type TaskId = string & { readonly __brand: 'TaskId' };
type UserId = string & { readonly __brand: 'UserId' };

// Prevents accidentally passing a UserId where a TaskId is expected
function getTask(id: TaskId): Promise<Task> { ... }
```

## 9. Common Rationalizations

| Rationalization                            | Reality                                                                                                          |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| "We'll document the API later"             | The types ARE the documentation. Define them first.                                                              |
| "We don't need pagination for now"         | You will the moment someone has 100+ items. Add it from the start.                                               |
| "PATCH is complicated, let's just use PUT" | PUT requires the full object every time. PATCH is what clients actually want.                                    |
| "We'll version the API when we need to"    | Breaking changes without versioning break consumers. Design for extension from the start.                        |
| "Nobody uses that undocumented behavior"   | Hyrum's Law: if it's observable, somebody depends on it. Treat every public behavior as a commitment.            |
| "We can just maintain two versions"        | Multiple versions multiply maintenance cost and create diamond dependency problems. Prefer the One-Version Rule. |
| "Internal APIs don't need contracts"       | Internal consumers are still consumers. Contracts prevent coupling and enable parallel work.                     |

## 10. Red Flags

- Endpoints that return different envelope shapes depending on conditions
  (the rule fixes the shape — see § 4).
- Validation scattered throughout internal code instead of at boundaries.
- Breaking changes to existing fields (type changes, removals).
- List endpoints without pagination.
- Verbs in REST URLs (`/api/createTask`, `/api/getUsers`).
- Third-party API responses used without validation or sanitization.

## 11. Authoring Checklist

Before opening a PR that adds or edits an API surface:

- [ ] Every endpoint has typed input and output schemas.
- [ ] Error responses follow the envelope in
      [`api-conventions.md` § Response Envelope](../../../rules/api-conventions.md#response-envelope).
- [ ] Status codes match
      [`api-conventions.md` § HTTP Status Codes](../../../rules/api-conventions.md#http-status-codes).
- [ ] Validation runs at the API boundary and returns the canonical
      `VALIDATION_ERROR` shape on failure.
- [ ] List endpoints support pagination.
- [ ] New fields are additive and optional (backward compatible).
- [ ] Naming follows
      [`api-conventions.md` § Payload Formatting](../../../rules/api-conventions.md#payload-formatting).
- [ ] API documentation or types are committed alongside the implementation.

## 12. Cross-References

- SSOT rules:
  [`.agents/rules/api-conventions.md`](../../../rules/api-conventions.md).
- Security validation guarantees:
  [`security-baseline.md`](../../../rules/security-baseline.md).
- Test-layer scope:
  [`testing-standards.md`](../../../rules/testing-standards.md).
