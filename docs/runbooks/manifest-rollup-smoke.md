# Manifest rollup smoke runbook

> Operator runbook for `scripts/smoke/manifest-rollup-smoke.js`. Owns the
> live verification step in the Epic #1178 close-out: render the synthetic
> Epic fixture, post it as a real GitHub comment, and confirm that
> (a) every Wave Summary TOC anchor resolves on the rendered page and
> (b) GitHub's native sub-issue / task-list rollup percentage matches the
> ratio of `[x]` to `[ ]` checkboxes in the markdown.

## When to run

- **Epic close-out** for any Epic that lands manifest-formatter changes
  (Epic #1178 and its successors).
- **Pre-release smoke** before bumping the agent-protocols VERSION when the
  release notes claim "GitHub native rollup unaffected" — the only way to
  prove that is to post a real comment and observe GitHub's UI.
- **Bisect aid** when an operator reports broken anchor links on a freshly
  generated dispatch manifest.

This is intentionally a **manual smoke**. Automation requires a live
HTTP fixture (or a recorded GitHub Pages mock), and the failure modes the
smoke catches are GitHub-side (anchor-prefix changes, sanitizer drift,
checkbox-grammar shifts) — exactly the things a recorded mock would not
notice.

## Prerequisites

- `GITHUB_TOKEN` exported with `repo` scope on the target repository
  (the same token `gh auth token` prints).
- Node 22 (the e2e fixture is Node-test based; the smoke shares the
  same `manifest-formatter.js` import).
- Run from the repository root so `.agentrc.json` is discoverable. The
  script falls back to `--repo <owner/repo>` when the config is absent.

## Invocation

```bash
# Dry run — render + verify locally, do NOT POST anything
node scripts/smoke/manifest-rollup-smoke.js --dry-run

# Live run against Epic #1178 in the configured repo
GITHUB_TOKEN=$(gh auth token) \
  node scripts/smoke/manifest-rollup-smoke.js --issue 1178

# Live run against a different issue / repo, leave the smoke comment in
# place so a screenshot can be captured for the Epic close-out notes
GITHUB_TOKEN=$(gh auth token) \
  node scripts/smoke/manifest-rollup-smoke.js \
  --issue 1178 --repo dsj1984/agent-protocols --keep
```

The script exits **0** on PASS, **1** on any anchor / rollup mismatch,
**2** on missing config.

## Output shape

JSON on stdout. The two PASS gates the runbook owner records in the Epic
close-out notes:

```json
{
  "anchorsRemote": { "pass": true,  "expected": 3, "failAnchors": [] },
  "rollup":        { "expected": "21%", "note": "Compare against the rendered Epic comment progress bar; PASS when the comment-page percentage equals expected." }
}
```

- `anchorsRemote.pass: true` → every TOC anchor in the rendered comment
  HTML resolves to a real `<h2 id="…">` (GitHub's `user-content-…` prefix
  is stripped before comparison).
- `rollup.expected` → the operator opens the live Epic / parent issue and
  compares the displayed sub-issue / task-list rollup percentage. PASS
  when the two match.

## Capturing the result in the Epic close-out

Per Epic #1178 acceptance criteria, the smoke result is captured in the
Epic close-out notes. Recommended snippet (drop directly into the
close-out comment on the Epic ticket):

```markdown
### Manifest rollup smoke (manual)

- Anchor links: PASS — 3/3 Wave Summary TOC links resolved on the
  rendered comment page.
- Native rollup: PASS — comment-page percentage matched the expected
  21% from the synthetic-Epic fixture.
- Comment URL: <link to the smoke comment, deleted after capture unless
  `--keep` was used>.

Run with:
`GITHUB_TOKEN=$(gh auth token) node scripts/smoke/manifest-rollup-smoke.js --issue 1178`
```

## Failure handling

- **`failTargets` non-empty in `anchorsLocal`** → the renderer's
  `slugifyHeading` is out of sync with the H2 heading text. Fix the
  formatter, not the smoke. Re-run with `--dry-run` until clean before
  posting again.
- **`failAnchors` non-empty in `anchorsRemote` but `anchorsLocal` was
  clean** → GitHub changed its anchor-prefix rules. Update the
  `normalized` fallback in `commentAnchorCheck` and document the new
  prefix in this runbook.
- **Rollup percentage off** → either GitHub's native rollup arithmetic
  changed (round-half-up vs. floor) or the `<details>` block leaked
  checkboxes the formatter shouldn't be emitting. Sweep the rendered
  markdown for stray `- [ ]` lines inside the bottom `<details>` first.
- **POST returns 403** → the token lacks `repo` scope, or the issue is
  in a different org. Re-mint the token via `gh auth refresh -s repo`.
