# Audit finding severity scale (shared)

> **Single source of truth for the `Severity` axis (Story #4625).** Every audit
> lens report references this file so the four levels — and the parser that
> ranks them — never drift per lens.

Every finding grades its severity (labelled `Severity` or `Impact` on a given
lens) on this ordered scale. `parse-audit-md.js` recognizes every level, and a
surviving **Critical** finding halts the delivery gate
(`lib/audit-suite/findings.js#hasSurvivingCritical`).

- **Critical** — an active, exploitable, or data-losing defect that must be
  fixed before the change can ship (e.g. a leaked secret, an auth bypass, a
  guaranteed production outage or data-loss path).
- **High** — a serious correctness, security, or maintainability risk that
  should be fixed promptly, but does not by itself block the release.
- **Medium** — a real problem worth scheduling; contained blast radius, or a
  reasonable workaround exists.
- **Low** — minor or cosmetic; fix opportunistically.
