---
description: Audit dependency CVEs, input-validation gaps, secrets handling, auth boundaries, and the trust-boundary attack classes the baseline is silent on (business logic, SSRF/traversal, deserialization, crypto misuse, feature abuse, LLM tool-binding); emit a structured High/Medium/Low findings report.
---

# Security & Vulnerability Audit

You are a Cybersecurity Architect conducting a comprehensive security review
(OWASP Top 10, insecure configs, attack vectors). The shared lens machinery
lives in
[`helpers/audit-lens-core.md`](helpers/audit-lens-core.md). Write the report to
`{{auditOutputDir}}/audit-security-results.md`. Extra finding fields: **CWE
ID:**, **Baseline MUST:** (the violated MUST, or `none — trust-boundary
class`) and **Boundary:** (Step 2's six-clause gate). The report adds a
**Defensive Recommendations** section (3–5 hardening headers/configs/
libraries, plus every hardening note Step 2 demotes).

Tier B, the Boundary gate and the anchors are adapted, in Mandrel's words,
from Cloudflare's MIT-licensed `security-audit` skill — prose rubric only;
this lens stays one read-only auditor and never runs target code.

## Scope

Per the core's Scope interpretation:

```text
{{changedFiles}}
```

## Execution strategy

Run this lens as one `subagent_type: auditor` dispatch per the core's
Execution strategy.

## Rubric — `rules/security-baseline.md` is the contract

This lens does **not** grade against recalled OWASP lore. The authoritative
rubric is [`../rules/security-baseline.md`](../rules/security-baseline.md) — the
project's inviolable security MUSTs. Read it first. **Every Tier A finding
MUST name the specific MUST it violates** (e.g. "violates _Secrets
Management_: 'Fallback or placeholder secrets MUST NOT be committed'"). **A
Tier B finding cites a CWE in `CWE ID` and writes `none — trust-boundary
class` in `Baseline MUST`** — the one sanctioned use of the CWE escape hatch.
A finding that fits neither tier is out of scope for this lens.

## Step 1: Detection Battery (Tool-First, Read-Only)

Ground every finding in tool output, not vibes. Each rung is **presence-** and
**ecosystem-gated** per the core's
[Ecosystem detection](helpers/audit-lens-core.md#ecosystem-detection): a
scanner absent for a detected ecosystem falls through to the next rung and is
noted as a `Security Misconfiguration` finding (recommend adopting it); one
for an undetected ecosystem is inapplicable and never a finding.

1. **Dependency CVEs, per detected ecosystem.** Never recall CVEs from memory:

   ```bash
   npm audit --omit=dev --json 2>/dev/null || echo "npm audit unavailable"  # JS
   pip-audit -r requirements.txt --format json   # Python (or bare `pip-audit` in the venv)
   govulncheck ./...                             # Go
   cargo audit --json                            # Rust
   ```

   Each advisory reachable in production (`--omit=dev`; for Python, runtime
   requirements only) at `high` or `critical` is a _Vulnerable Components_
   finding citing the advisory id and the _Dependency Hygiene_ MUST.

   **Python static analysis.** On a detected Python ecosystem also run
   `bandit -r <srcDir> -f json` for injection / `eval` / `shell=True` /
   weak-crypto sinks — the Python counterpart of the grep battery below.

2. **Secret scanning (`gitleaks` / `trufflehog`), with a grep fallback.**
   Prefer `gitleaks` when installed:

   ```bash
   command -v gitleaks >/dev/null 2>&1 && gitleaks detect --no-banner --redact -v || \
     command -v trufflehog >/dev/null 2>&1 && trufflehog filesystem . --no-update || \
     echo "no secret scanner installed — running the grep battery below"
   ```

3. **Grep battery (deterministic fallback / augmentation).** Run these
   regardless — cheap, and they catch what a scanner's ruleset misses:

   ```bash
   # Hardcoded key material (violates Secrets Management)
   rg -n -i "(api[_-]?key|secret|password|token)\s*[:=]\s*['\"][^'\"]{8,}" --glob '!**/*.test.*'
   # eval / exec sinks (violates Output & Rendering)
   rg -n "\b(eval|new Function|child_process\.exec|execSync)\s*\(" --glob '!**/*.test.*'
   # Template-literal SQL (violates Output & Rendering — parameterize)
   rg -n "(SELECT|INSERT|UPDATE|DELETE)\b[^;]*\$\{" -i
   # Committed .env with real values (violates Secrets Management)
   git ls-files | rg "(^|/)\.env($|\.)" | rg -v "\.env\.example$"
   # Python sinks (detected Python only): shell exec, unsafe deserialization, f-string SQL
   rg -n "shell=True|pickle\.loads?\(|yaml\.load\(|\.execute\(f['\"]" --type py
   ```

4. **Manual surface review.** Then read the surfaces the battery flags plus:
   input-validation edges (is input schema-validated at the boundary?),
   auth/session handling (token storage, missing ownership checks on
   sensitive routes), and injection sinks (`dangerouslySetInnerHTML`, raw
   SQL, command execution). On Python, read the route decorators (Django /
   DRF `permission_classes`, Flask / FastAPI `Depends` guards) for missing
   ownership checks.

## Step 2: Evaluation Dimensions

### Tier A — baseline-anchored (cite the MUST)

1. **Injection:** SQL, NoSQL, OS Command, and Cross-Site Scripting (XSS) —
   _Output & Rendering_.
2. **Broken Access Control:** Can a user access data they don't own? —
   _Authorization_.
3. **Cryptographic Failures:** Is sensitive data hashed or encrypted to
   modern standards? — _Authentication_ / _Data Leakage & Logging_.
4. **Security Misconfiguration:** Default passwords, verbose production
   errors, insecure headers? — _Transport & Headers_.
5. **Vulnerable Components:** Outdated libraries introducing risk? —
   _Dependency Hygiene_.

### Tier B — trust-boundary classes (cite a CWE)

Each class names the sibling lens owning adjacent territory; when the only
defect is the sibling's, cite that lens and drop the finding here.

1. **Business logic & state machines:** steps skipped, reordered or replayed;
   partial failure leaving step 1 applied; numeric coercion (negative, zero,
   overflow, string↔number); expiry and rate windows at exact instants; the
   posture when config is missing, a flag is off or a migration is half
   applied; stored data trusted because another path "validated it on the way
   in". Check-then-act races and non-atomic writes are `/audit-performance`'s
   Interleaving dimension, not this class.
2. **Access-control depth:** whether the check that exists is the correct
   one for this resource and this operation — a second path to the same
   state change behind a weaker permission; a body field overriding what the permission model
   restricts; authenticated-but-never-authorized endpoints; bulk, batch,
   export and import paths skipping per-item checks. Shares the
   _Authorization_ MUST with Tier A — merge rather than double-file.
3. **Resource & file handling:** path traversal via symlinks, encoded
   sequences or null bytes; SSRF via user-supplied fetch, webhook or callback
   URLs and their redirects; unsafe deserialization; zip slip; temp files.
   Install scripts and lockfile provenance are `/audit-dependencies`'s.
4. **Cryptography & secrets misuse:** weak randomness for tokens or nonces;
   timing-unsafe comparison; nonce/IV reuse; unauthenticated modes, missing
   HMAC checks; error paths that fall back to no crypto. Hardcoded-secret
   _presence_ is Step 1's rung and `/audit-privacy`'s — this is about _use_.
5. **Feature abuse & data leakage:** export or backup including data above
    the caller's level; import or restore bypassing validation or permissions;
    search/filter/sort as an existence oracle; enumeration through differing
    errors, timings or status codes; over-scoped preview tokens; cache
    headers serving private content from a shared cache. PII-in-logs and
    retention are `/audit-privacy`'s.
6. **LLM & tool-binding boundaries** (ecosystem-gated: only when manifests
    or imports show prompt assembly, a model API, tool/MCP definitions or
    agent memory; otherwise omit silently): indirect prompt injection via
    retrieved content; tool arguments reaching a downstream sink;
    confused-deputy actions bound to the wrong principal; approval not bound
    to the final action and resource; sub-agent or MCP trust inherited
    unchecked; model output rendered or executed unsanitized.

### The Boundary gate (every finding, both tiers)

Fill **Boundary:** as one line of six clauses: _lower-trust
principal → accepted input or action → intended control → crossed boundary →
affected principal or resource → observed or owner-observable result_. Three
rules follow:

- **An unfillable Boundary is not a finding.** A best practice that is merely
  absent, with nobody and nothing concretely exposed, is a **hardening note**
  under `## Defensive Recommendations`, never under `## Detailed Findings`.
- **Defense-in-depth gaps are hardening notes.** When one present layer
  already prevents the crossing, a missing second layer is a note.
- **Severity never exceeds the demonstrated result.** A crash is not code
  execution; self-impact is not privilege gain. A deployment fact absent from
  the repo (proxy, provider, identity policy, CDN) is neither assumed present
  nor absent: name it in `Current State`, grade on the demonstrated result
  only, and let the self-cross-check keep or drop it on the ordinary bar.

## Step 3: Severity anchors (security-anchored)

Grade on the shared scale, anchored to the Boundary result:

- **Critical** — no credentials needed and the result is code execution,
  the whole data store, or any account the caller picks; or a leaked secret.
- **High** — an explicit control is wholly circumvented with real effect:
  logging in as someone else, reading or writing another tenant's data,
  persisted script that runs for other users, or RCE behind a login.
- **Medium** — a genuine crossing, but small: rare preconditions, few
  affected records, or a narrow resource set.
- **Low** — internals that are not secret become visible, or the gain is
  tiny for the effort.
- **Info** — real but negligible on its own; worth recording as a stepping
  stone inside a larger finding.

The High/Medium line: is the control **wholly circumvented** for an action
that matters, or merely weakened? When you cannot name the concrete damage,
grade lower than instinct suggests.

## Report additions

Beyond the core's shared skeleton, this lens adds its title, a Defensive
Recommendations section and the CWE ID / Baseline MUST / Boundary fields:

```markdown
# Security Audit Report

## Defensive Recommendations

- [3-5 headers, configs or libraries to harden the app, then every
  hardening note the Boundary gate demoted.]

### `path/to/primary-file.ext` — [Short title of the issue]

- **Dimension:** [a Tier A or Tier B dimension from Step 2]
- **Severity:** [Critical | High | Medium | Low | Info — per Step 3]
- **CWE ID:** [CWE-nnn]
- **Baseline MUST:** [the violated MUST | none — trust-boundary class]
- **Boundary:** [principal → input → control → crossed boundary → resource → result]
- [Location, Current State, Recommendation & Rationale (the smallest source
  fix and why), Acceptance signal — per the core skeleton]
```
