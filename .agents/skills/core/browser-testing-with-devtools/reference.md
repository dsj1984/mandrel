# Browser Testing with DevTools — Reference (on-demand)

**Read this when** a task engages one of the sections below and the Policy
Capsule in [`SKILL.md`](SKILL.md) does not settle it on its own. The capsule
is the contract; this file is the reference material behind it. The
untrusted-data and JS-execution security constraints live in the capsule and
are not repeated here; generic DevTools tool tables and symptom-by-symptom
workflow ladders are omitted as frontier-known.

## Setting Up Chrome DevTools MCP

Add the Chrome DevTools MCP server to your project's `.mcp.json` (or Claude
Code settings):

```json
{
  "mcpServers": {
    "chrome-devtools": {
      "command": "npx",
      "args": ["@anthropic/chrome-devtools-mcp@latest"]
    }
  }
}
```

This gives the agent screenshot capture, DOM inspection, console logs, a
network monitor, performance traces, computed styles, the accessibility tree,
and read-only JavaScript execution — the runtime evidence that static code
analysis cannot provide.

## Writing Test Plans for Complex UI Bugs

For a complex UI issue, write a structured test plan the agent can follow in
the browser — each step names its expected result and the console/network
checks that confirm it:

```markdown
## Test Plan: Task completion animation bug

### Setup

1. Navigate to http://localhost:3000/tasks
2. Ensure at least 3 tasks exist

### Steps

1. Click the checkbox on the first task
   - Expected: strikethrough animation, task moves to "completed" section
   - Check: console has no errors
   - Check: network shows PATCH /api/tasks/:id with { status: "completed" }

2. Click undo within 3 seconds
   - Expected: task returns to the active list with reverse animation
   - Check: network shows PATCH /api/tasks/:id with { status: "pending" }

### Verification

- [ ] All steps completed without console errors
- [ ] Network requests are correct and not duplicated
- [ ] Visual state matches expected behavior
- [ ] Accessibility: task status changes are announced to screen readers
```

## Screenshot-Based Verification

Use screenshots for visual regression checks: take a "before" screenshot, make
the code change, reload, take an "after" screenshot, and compare. This is
especially valuable for CSS changes, responsive layouts at different viewports,
loading/empty/error states, and transitions.

**Clean-console standard.** A production-quality page has **zero** console
errors and warnings. If the console is not clean after a browser-touching
change, fix the warnings before shipping — warnings become errors, and a clean
console catches bugs early.
