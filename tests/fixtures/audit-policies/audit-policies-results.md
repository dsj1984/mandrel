# Policy Consistency Audit Report

## Executive Summary

Two published commitments diverge from the implementation; one practice is
undisclosed.

This audit checks consistency between published text and implementation, not legal adequacy, and is not legal advice.

Self-cross-check: kept 3 / dropped 1.
Severity tally: Critical 0 / High 1 / Medium 1 / Low 1
Direction split: text 0 / code 1 / undecided 2

## Claims Coverage

| Policy | Claims extracted | Verified | Backed | Accepted | Findings |
| --- | --- | --- | --- | --- | --- |
| `site/legal/privacy-policy.md` | 12 | 9 | 1 | 0 | 2 |
| `site/legal/refund-policy.md` | 4 | 3 | 0 | 0 | 1 |

## Detailed Findings

### `site/legal/privacy-policy.md` — Erasure promised within 35 days while the purge job runs in dry-run

- **Dimension:** Unbacked Promise
- **Severity:** High
- **Policy:** `site/legal/privacy-policy.md` — "We confirm erasure of your data within 35 days of your request."
- **Implementation:** `src/jobs/purge.js:14` — the purge job defaults to `dryRun: true`
- **Backing:** none
- **Direction:** undecided
- **Location:** `site/legal/privacy-policy.md:42`
- **Current State:** The policy commits to confirmed erasure within 35 days; `src/jobs/purge.js` never deletes while `dryRun` is on.
- **Recommendation & Rationale:** Decide whether to change the code to honor the text (arm the purge job) or change the text to describe the code; this lens drafts no wording.
- **Acceptance signal:** A recorded operator decision on the Direction, then either the purge job's live run or the revised policy sentence.

### `site/legal/privacy-policy.md` — Shipping provider receives family data no policy discloses

- **Dimension:** Undisclosed Practice
- **Severity:** Medium
- **Policy:** `site/legal/privacy-policy.md` — "We share your data only with the payment processor."
- **Implementation:** `src/shipping/client.js:8` — posts name and address to the shipping provider
- **Backing:** none
- **Direction:** undecided
- **Location:** `src/shipping/client.js:8`
- **Current State:** The code sends personal data to a recipient the recipients list omits.
- **Recommendation & Rationale:** Decide whether to stop the transfer or disclose the recipient; this lens drafts no wording.
- **Acceptance signal:** A recorded operator decision on the Direction.

### `site/legal/refund-policy.md` — Fee described as one-time here and annual in the terms

- **Dimension:** Internal Inconsistency
- **Severity:** Low
- **Policy:** `site/legal/refund-policy.md` — "The registration fee is a one-time charge."
- **Implementation:** `src/billing/fees.js:21` — charges the fee every season
- **Backing:** none
- **Direction:** code
- **Location:** `site/legal/refund-policy.md:9`
- **Current State:** Two policies disagree on the fee cadence, and the code matches neither one consistently.
- **Recommendation & Rationale:** Decide which cadence is intended and align the other policy; this lens drafts no wording.
- **Acceptance signal:** A recorded operator decision on the Direction.
