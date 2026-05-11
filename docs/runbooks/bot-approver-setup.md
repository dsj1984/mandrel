# Story 3 — Bot approver setup (s3-bot-approver)

> Runbook for Epic #1235 / Story #1240. Operator-driven GitHub App
> provisioning that the in-tree `bot-approve.yml` workflow needs to mint an
> installation token and post an approving review on green CI. The in-tree
> artifacts (`.github/workflows/bot-approve.yml`, `.github/ruleset.json`)
> are committed by sibling tasks; this file captures the **live-state**
> work a human operator must do against GitHub before the workflow can run.

## Why this is a runbook, not a script

A GitHub App is persistent server-side state owned by a user or
organization, not source. Creating one programmatically requires a
pre-existing App with manifest-flow scopes — a chicken-and-egg the agent
cannot bootstrap on the operator's behalf. The `manual:` prefix on this
Story's `## Verify` lines for `t3-workflow` and `t3-ruleset-approval` is
load-bearing: it tells `/story-execute` that the App provisioning and the
final `gh api PUT` against the ruleset are operator follow-ups, not checks
the close-validation chain runs.

---

## Task #1250 — Provision the GitHub App

### 1. Create the App

Navigate to **Settings → Developer settings → GitHub Apps → New GitHub App**
(under your personal account, or an org if you prefer org-owned). Fill in:

| Field                | Value                                                                     |
| -------------------- | ------------------------------------------------------------------------- |
| GitHub App name      | `agent-protocols-reviewer`                                                |
| Homepage URL         | `https://github.com/dsj1984/agent-protocols`                              |
| Callback URL         | `https://github.com/dsj1984/agent-protocols` (unused; required field)     |
| Webhook → Active     | Unchecked (the App is API-only; no webhook deliveries are needed)         |

### 2. Scopes (repository permissions)

Set **exactly** these two and nothing else:

| Permission       | Access       | Why                                                                          |
| ---------------- | ------------ | ---------------------------------------------------------------------------- |
| Pull requests    | Read & write | Required to POST `/repos/:owner/:repo/pulls/:n/reviews` with `event=APPROVE` |
| Metadata         | Read-only    | Mandatory baseline scope on every App; cannot be unset                       |

The bot must **not** hold `contents:write`, `actions:write`, or
`administration:*`. The principle of least privilege is the whole point of
using an App instead of a PAT — if the App key leaks, the blast radius is
"can approve a PR", not "can push to main".

Account permissions: leave all unset. Subscribe to events: leave all
unchecked.

### 3. Install the App on the repo

After **Create GitHub App**, scroll to **Install App** in the left nav.
Install on the `dsj1984` account and select **Only select repositories →
agent-protocols**. Do not grant **All repositories** — the bot has no
business approving PRs in unrelated repos.

### 4. Generate a private key

From the App settings page, scroll to **Private keys → Generate a private
key**. A `.pem` file downloads to your machine.

> **Do not commit this file.** The `.pem` is a long-lived credential
> equivalent to the App's password. If it lands in a commit, even on a
> feature branch, treat it as compromised: revoke the key from the App
> settings, generate a new one, and re-seed the repo secret below.

### 5. Capture the App ID

On the same App settings page, copy the numeric **App ID** (top of the
page, next to the App name). You will need it in step 6.

### 6. Seed repo secrets

From the repo root with `gh auth` against `dsj1984/agent-protocols`:

```bash
gh secret set BOT_APPROVER_APP_ID --body "<numeric App ID from step 5>"
gh secret set BOT_APPROVER_PRIVATE_KEY < path/to/agent-protocols-reviewer.<date>.private-key.pem
```

The secret names are load-bearing — `.github/workflows/bot-approve.yml`
references them verbatim as `${{ secrets.BOT_APPROVER_APP_ID }}` and
`${{ secrets.BOT_APPROVER_PRIVATE_KEY }}`. Renaming either side breaks the
workflow.

After seeding, delete the `.pem` from your local machine:

```bash
rm path/to/agent-protocols-reviewer.<date>.private-key.pem
```

GitHub stores the secret encrypted at rest; the local copy is no longer
needed and removing it shrinks the leak surface.

### 7. Record the App ID in the merge PR description

When the Story #1240 PR opens against `epic/1235`, paste the App ID into
the PR description under a `## Bot identity` heading. This makes the
App-ID ↔ workflow binding auditable from PR history without having to
crawl repo-secret values.

---

## Task #1252 — Smoke-test the workflow

After `.github/workflows/bot-approve.yml` lands and the App is installed:

1. Open a trivial PR against `epic/1235` (e.g. a one-line README touch) as
   your normal user account, not the bot.
2. Wait for `CI / CD` to complete green on both OS contexts.
3. Within ~60s of CI conclusion, the `bot-approve` workflow run should
   appear under the **Actions** tab with `conclusion: success` and the PR
   should show an **Approved** review from `agent-protocols-reviewer[bot]`.

If the workflow fails:

- `401 Unauthorized` from `actions/create-github-app-token` → secret value
  mismatch. Re-seed `BOT_APPROVER_PRIVATE_KEY` (paste the entire `.pem`
  including `-----BEGIN/END-----` lines).
- `404 Not Found` on `POST /pulls/:n/reviews` → App is not installed on
  this repo, or installation is scoped to a different repo. Re-check
  step 3.
- `422 Unprocessable Entity` with `Can not approve your own pull
  request` → the PR was authored by the bot itself (the workflow's
  self-author guard should have skipped it; check the `no-op if bot
  authored` step in the workflow log).

---

## Task #1254 — Re-PUT the ruleset

Once the workflow has posted at least one successful approving review
against a real green PR (so you have positive evidence the App identity
works), the operator runs:

```bash
gh api -X PUT repos/:owner/:repo/rulesets/14286998 \
  --input .github/ruleset.json
```

The committed `.github/ruleset.json` carries the new `pull_request` rule
(`required_approving_review_count: 1`,
`dismiss_stale_reviews_on_push: false`). Until this PUT lands, the
rule lives only in-tree and the live ruleset still gates on CI alone.

### Expected post-state

```bash
gh api repos/:owner/:repo/rulesets/14286998 \
  --jq '[.rules[] | select(.type=="pull_request")] | length'
# → 1

gh api repos/:owner/:repo/rulesets/14286998 \
  --jq '[.rules[] | select(.type=="pull_request")][0].parameters'
# → { "required_approving_review_count": 1, "dismiss_stale_reviews_on_push": false, ... }
```

A green PR with **no** approving review should now show a blocked Merge
button citing the missing approval; the same PR after the bot review
should unblock to a green Merge button.

---

## Rollback

If the bot starts mis-approving (e.g. a workflow logic bug causes it to
approve PRs from itself or skip the green-CI gate), detach the approval
rule without uninstalling the App so the repo falls back to CI-only:

```bash
# Edit .github/ruleset.json to drop the pull_request rule, then:
gh api -X PUT repos/:owner/:repo/rulesets/14286998 \
  --input .github/ruleset.json
```

To fully revoke the bot identity (e.g. private key suspected leaked):

1. App settings → **Suspend** (revokes all installation tokens immediately).
2. App settings → **Private keys** → delete the compromised key.
3. Repo secrets → delete `BOT_APPROVER_APP_ID` and
   `BOT_APPROVER_PRIVATE_KEY` so a stale workflow run cannot retry against
   a dangling identity.

Re-provision per the steps above once the underlying issue is fixed.
