# Comment Policy

This rule applies when writing or editing comments in JavaScript under
`.agents/scripts/`, `bin/` or `lib/`. Tests and generated files are exempt.

## The rule

A comment states what a reader cannot get from the code: the **contract**, the
**invariant**, the non-obvious **why**.

- **Say it once, at the narrowest scope that owns it.** A module header names
  the module's job and any module-wide contract. A function doc states that
  function's contract. An inline comment explains the one line it sits on. The
  same sentence does not appear in all three.
- **Never narrate history.** No Story, PR, Epic or ADR numbers, no bare
  `#1234` issue references, and no "previously", "used to" or "the old code".
  Git history and [`docs/decisions.md`](../decisions.md) already hold the
  story of how the code got here.
- **Keep the reason, drop the incident.** When a branch exists because of a
  real failure, keep the reason it still matters and drop how it was found.
  "Story #4866 — CRAP rows mix transpiled and original line coordinates, so
  provenance must be filtered before counting" becomes "CRAP rows can mix
  transpiled and original coordinates; filter provenance before counting."
- **JSDoc type tags stay.** `@param`, `@returns`, `@typedef`, `@throws`,
  `@type`, `@property` and `@template` are the type surface. Their prose may be
  short, but the tag, the `{type}` and the name are kept.
- **Tool directives stay.** `biome-ignore`, `eslint-*`, `@ts-*`,
  `node:coverage`, `// cli-opt-out: <reason>`, `// test-temp-allow:`,
  shebangs and license headers are read by tools, not people.

Delete a comment that restates the code, lists a function's callers, or walks
through a trivial example. Rewrite a comment that carries an invariant even
when it also cites a ticket — deleting it loses the invariant.

## The ratchets

[`scripts/check-comment-policy.js`](../../scripts/check-comment-policy.js)
enforces two rules. It is a `scripts/run-lint.js` task, so the close `lint`
gate, CI's required `lint` check and `npm run verify` all run it, and the
`pre-push` hook runs it directly. A breach fails locally, naming the check,
before it can reach CI:

| Ratchet | Fails when |
| --- | --- |
| Comment ratio | Comment bytes exceed the landed ceiling (`COMMENT_RATIO_CEILING` in `scripts/lib/comment-policy.js`) as a share of non-generated, non-test `.agents/scripts` JavaScript bytes. The ceiling may only be lowered. |
| Provenance | Any comment under `.agents/scripts`, `bin` or `lib` cites `Story #N`, `PR #N`, `Epic #N`, `ADR <date-id>` or a bare `#NN` issue number. |

Both use a dependency-free scanner that understands string, template and
regular-expression literals, so a `//` inside a URL is not a comment.

```bash
node scripts/check-comment-policy.js                 # both ratchets
node scripts/check-comment-policy.js --report        # per-file comment bytes
node scripts/check-comment-policy.js --assert-code-unchanged origin/main
```

`--assert-code-unchanged <ref>` proves a change is comment-only: every scanned
file that differs from `<ref>` must have the same code once comments and
formatting whitespace are removed, and must keep every JSDoc type tag. Run it
after any bulk comment edit.

## Guards that read source text

A test or lint that greps source for a pattern must strip comments first with
[`stripJsComments`](../../.agents/scripts/lib/source-text/strip-js-comments.js).
A guard that only passes because a comment happens to mention the pattern is
fixed by stripping comments, never by keeping the comment.
