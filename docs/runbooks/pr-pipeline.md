# PR pipeline activation

> Epic #1235's hands-off PR pipeline has two halves:
>
> 1. **Repo + ruleset config** — controllable via `gh api`, **already applied by Claude on 2026-05-11**.
> 2. **Bot approver identity** — requires GitHub UI / account-level work, **what's left for you**.
>
> This runbook lists only the work that's still yours. Once you complete the four steps in [§ Your remaining work](#your-remaining-work), tell Claude "bot is up" and the final ruleset PUT lands automatically.

---

## Status snapshot

### ✅ Done (Claude applied these via `gh api` on 2026-05-11)

| Surface | State |
|---|---|
| Repo merge methods | `allow_squash_merge: true`, `allow_rebase_merge: false`, `allow_merge_commit: false`, `allow_auto_merge: true`, `delete_branch_on_merge: true` |
| Ruleset `14286998` rules | `deletion`, `non_fast_forward`, `required_linear_history`, `required_status_checks` (Ubuntu CI leg only, strict policy) |
| Ruleset bypass | `bypass_actors: []`, `current_user_can_bypass: never` |
| Approval rule | **Not active** (Path A) — fine to ship PRs now; CI is the gate |

What this means today: every new PR you open can be merged with `gh pr merge --auto --squash --delete-branch` and it will land itself the moment the Ubuntu CI leg (`Validate and Test (ubuntu-latest, node 22)`) reports success. No reviewer needed. No admin bypass. The Windows leg was removed on 2026-05-11 — the operator runs Windows locally and the pre-push hook is the real Windows gate; see `.github/workflows/ci.yml` for the matrix history.

### ⏳ Pending (your work — see § Your remaining work)

| Step | Surface |
|---|---|
| Create GitHub App | github.com/settings/apps |
| Install on this repo | github.com/settings/installations |
| Seed repo secrets | `BOT_APPROVER_APP_ID`, `BOT_APPROVER_PRIVATE_KEY` |
| Smoke-test on a real PR | one trivial PR to confirm bot review fires |

### 🤖 Will run after you ping Claude

| Action | What it does |
|---|---|
| Re-PUT ruleset (Path B) | Activates `required_approving_review_count: 1` — the bot becomes the satisfier on every green PR |

---

## Your remaining work

### 1. Create the GitHub App

Navigate to **Settings → Developer settings → GitHub Apps → New GitHub App** under your personal account (or an org if you prefer org-owned). Fill in:

| Field | Value |
|---|---|
| GitHub App name | `agent-protocols-reviewer` |
| Homepage URL | `https://github.com/dsj1984/agent-protocols` |
| Callback URL | `https://github.com/dsj1984/agent-protocols` (unused; required field) |
| Webhook → Active | **Unchecked** (the App is API-only; no webhook deliveries are needed) |

#### Scopes — repository permissions

Set **exactly** these two and nothing else:

| Permission | Access | Why |
|---|---|---|
| Pull requests | Read & write | Required to POST `/repos/:owner/:repo/pulls/:n/reviews` with `event=APPROVE` |
| Metadata | Read-only | Mandatory baseline scope on every App; cannot be unset |

The bot must **not** hold `contents:write`, `actions:write`, or `administration:*`. The principle of least privilege is the whole point of using an App instead of a PAT — if the App key leaks, the blast radius is "can approve a PR", not "can push to main".

Account permissions: leave all unset. Subscribe to events: leave all unchecked.

> _Future expansion note_: Story 4's auto-fix loop needs `contents:write` to push the fix commit. You can either grant it on this App later (when you want the auto-fix loop active) or provision a separate identity. Either way, defer it — the bot-approve workflow does not need write access.

### 2. Install the App on the repo

After **Create GitHub App**, scroll to **Install App** in the left nav. Install on the `dsj1984` account and select **Only select repositories → agent-protocols**. Do not grant **All repositories** — the bot has no business approving PRs in unrelated repos.

### 3. Generate a private key

From the App settings page, scroll to **Private keys → Generate a private key**. A `.pem` file downloads to your machine.

> **Do not commit this file.** The `.pem` is a long-lived credential equivalent to the App's password. If it lands in a commit, even on a feature branch, treat it as compromised: revoke the key from the App settings, generate a new one, and re-seed the repo secret below.

### 4. Seed repo secrets

On the same App settings page, copy the numeric **App ID** from the top of the page. Then from the repo root with `gh auth` against `dsj1984/agent-protocols`:

```bash
gh secret set BOT_APPROVER_APP_ID --body "<numeric App ID>"
gh secret set BOT_APPROVER_PRIVATE_KEY < path/to/agent-protocols-reviewer.<date>.private-key.pem
```

The secret names are load-bearing — `.github/workflows/bot-approve.yml` references them verbatim as `${{ secrets.BOT_APPROVER_APP_ID }}` and `${{ secrets.BOT_APPROVER_PRIVATE_KEY }}`. Renaming either side breaks the workflow.

After seeding, delete the `.pem` from your local machine:

```bash
rm path/to/agent-protocols-reviewer.<date>.private-key.pem
```

GitHub stores the secret encrypted at rest; the local copy is no longer needed and removing it shrinks the leak surface.

---

## Ping Claude — "bot is up"

Claude will then:

1. **Re-PUT the ruleset** (Path B) — applies `.github/ruleset.json` verbatim against the live ruleset, which re-adds the `pull_request` rule with `required_approving_review_count: 1`.
2. **Verify post-state** — read-back via:

   ```bash
   gh api repos/:owner/:repo/rulesets/14286998 --jq '[.rules[].type] | sort'
   # → ["deletion","non_fast_forward","pull_request","required_linear_history","required_status_checks"]
   ```

3. **Optionally** open a trivial smoke-test PR against `main` (e.g. a README touch) and watch the `bot-approve` workflow fire on green CI within ~60s.

You can ping Claude before step 5 too if you want — there's no harm in having the bot up but the approval rule still inactive. Path B is just the gate that *requires* the bot's review.

---

## Smoke-test once Path B is live

1. Open a trivial PR (e.g. one-line README touch).
2. Wait for `CI / CD` to complete green on the Ubuntu leg.
3. Within ~60s, the `bot-approve` workflow should appear under the **Actions** tab with `conclusion: success` and the PR should show an **Approved** review from `agent-protocols-reviewer[bot]`.
4. The PR's green Merge button should then unblock — auto-merge fires if you marked the PR `--auto`.

If something fails:

- `401 Unauthorized` from `actions/create-github-app-token` → secret value mismatch. Re-seed `BOT_APPROVER_PRIVATE_KEY` (paste the entire `.pem` including `-----BEGIN/END-----` lines).
- `404 Not Found` on `POST /pulls/:n/reviews` → App is not installed on this repo, or installation is scoped to a different repo. Re-check step 2.
- `422 Unprocessable Entity` with `Can not approve your own pull request` → the PR was authored by the bot identity. The workflow's self-author guard should have skipped it; check the `no-op if bot authored` step in the workflow log.

---

## Rollback

### If Path B causes immediate breakage

Detach the approval rule without uninstalling the App so the repo falls back to CI-only (Path A):

```bash
# Build a one-shot trimmed payload (no pull_request rule):
node -e "const fs=require('fs');const r=JSON.parse(fs.readFileSync('.github/ruleset.json','utf8'));r.rules=r.rules.filter(x=>x.type!=='pull_request');fs.writeFileSync('temp/ruleset-no-approval.json',JSON.stringify(r,null,2));"

# PUT it:
gh api -X PUT repos/:owner/:repo/rulesets/14286998 --input temp/ruleset-no-approval.json
```

The committed `.github/ruleset.json` stays unchanged (still the Path B shape), so you can flip back to Path B with one command when the underlying issue is fixed.

### If the bot identity is compromised (private key suspected leaked)

1. App settings → **Suspend** (revokes all installation tokens immediately).
2. App settings → **Private keys** → delete the compromised key.
3. Repo secrets → delete `BOT_APPROVER_APP_ID` and `BOT_APPROVER_PRIVATE_KEY` so a stale workflow run cannot retry against a dangling identity.

Re-provision per § Your remaining work once the underlying issue is fixed.

### If the whole pipeline causes immediate breakage

Detach the entire ruleset until the issue is understood:

```bash
gh api -X PATCH repos/:owner/:repo/rulesets/14286998 -F enforcement=disabled
```

And restore the audit-snapshot merge settings:

```bash
gh api -X PATCH repos/:owner/:repo -F allow_rebase_merge=true
```

Re-enable both once the underlying issue is fixed. Do **not** edit `bypass_actors` back to allow admin override without a paper trail — re-PUT the corrected `.github/ruleset.json` instead so the in-tree artifact stays the source of truth.

---

## Source-of-truth pointers

- Ruleset payload: [`.github/ruleset.json`](../../.github/ruleset.json) — Path B shape (with the `pull_request` rule). The Path A "Claude already applied this" state was derived by trimming this file in-flight.
- Workflows the bot powers: [`.github/workflows/bot-approve.yml`](../../.github/workflows/bot-approve.yml), [`.github/workflows/auto-fix.yml`](../../.github/workflows/auto-fix.yml).
- Triage workflow (no bot needed): [`.github/workflows/triage-pr-failure.yml`](../../.github/workflows/triage-pr-failure.yml).
- CI workflow this pipeline layers on top of: [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml).
