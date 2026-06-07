import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  REDACTION_PLACEHOLDERS,
  redactEvidence,
} from '../../../.agents/scripts/lib/qa/redact-evidence.js';

/**
 * Story #3717 — evidence redaction pass before persistence.
 *
 * The QA harness (Epic #3686) must scrub secrets and PII from captured
 * evidence before any disk write or GitHub post, per the security baseline
 * (`.agents/rules/security-baseline.md` § Data Leakage & Logging). These
 * tests pin the four load-bearing behaviours from the Story's acceptance
 * criteria:
 *
 *   1. bearer tokens, session cookies, and email addresses are removed;
 *   2. the pass is idempotent (re-running on redacted text is a no-op);
 *   3. text matching no rule passes through unchanged;
 *   4. the suite exits 0 (asserted by CI running `node --test`).
 */

describe('redactEvidence — secret & PII removal', () => {
  it('removes a bearer token while preserving the Bearer keyword', () => {
    const input =
      'GET /api authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abc123';
    const output = redactEvidence(input);

    assert.ok(
      !output.includes('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9'),
      'token value must not survive redaction',
    );
    assert.ok(
      output.includes(REDACTION_PLACEHOLDERS.bearer),
      'bearer placeholder must be substituted',
    );
    assert.ok(
      output.includes('Bearer '),
      'the non-secret Bearer keyword is preserved',
    );
  });

  it('removes a session cookie value while preserving the cookie name', () => {
    const input = 'cookie: sessionId=s3cr3tV4lue9876; theme=dark';
    const output = redactEvidence(input);

    assert.ok(
      !output.includes('s3cr3tV4lue9876'),
      'cookie value must not survive redaction',
    );
    assert.ok(
      output.includes(REDACTION_PLACEHOLDERS.cookie),
      'cookie placeholder must be substituted',
    );
    assert.ok(
      output.includes('sessionId='),
      'the cookie name is preserved for readability',
    );
    assert.ok(
      output.includes('theme=dark'),
      'a non-session cookie is left untouched',
    );
  });

  it('redacts a variety of session-cookie names', () => {
    for (const name of [
      'connect.sid',
      'auth_token',
      'JSESSIONID',
      'csrf_token',
    ]) {
      const output = redactEvidence(`${name}=deadbeefcafe1234`);
      assert.ok(
        !output.includes('deadbeefcafe1234'),
        `value of ${name} must be redacted`,
      );
      assert.ok(output.includes(REDACTION_PLACEHOLDERS.cookie));
    }
  });

  it('removes an email address entirely', () => {
    const input = 'error reported by jane.doe+qa@example.co.uk during run';
    const output = redactEvidence(input);

    assert.ok(
      !output.includes('jane.doe+qa@example.co.uk'),
      'email address must not survive redaction',
    );
    assert.ok(
      output.includes(REDACTION_PLACEHOLDERS.email),
      'email placeholder must be substituted',
    );
  });

  it('scrubs all three secret classes in a single string', () => {
    const input =
      'user admin@corp.example logged in; Authorization: Bearer tok_ABCDEFGH123456; set-cookie: session=zzzzPRIVATEzzzz';
    const output = redactEvidence(input);

    assert.ok(!output.includes('admin@corp.example'));
    assert.ok(!output.includes('tok_ABCDEFGH123456'));
    assert.ok(!output.includes('zzzzPRIVATEzzzz'));
    assert.ok(output.includes(REDACTION_PLACEHOLDERS.email));
    assert.ok(output.includes(REDACTION_PLACEHOLDERS.bearer));
    assert.ok(output.includes(REDACTION_PLACEHOLDERS.cookie));
  });
});

describe('redactEvidence — idempotence', () => {
  it('is a no-op when re-run on already-redacted text', () => {
    const input =
      'Bearer eyJ0eXAaaa.bbb.ccc for contact@example.com via sid=topsecretvalue';
    const once = redactEvidence(input);
    const twice = redactEvidence(once);

    assert.equal(twice, once, 'second pass must not change redacted output');
  });

  it('the placeholders themselves survive a redaction pass unchanged', () => {
    const placeholders = Object.values(REDACTION_PLACEHOLDERS).join(' | ');
    assert.equal(redactEvidence(placeholders), placeholders);
  });
});

describe('redactEvidence — pass-through', () => {
  it('returns a string matching no rule unchanged', () => {
    const benign =
      'TypeError: cannot read property foo of undefined at line 42';
    const output = redactEvidence(benign);

    assert.equal(output, benign);
  });

  it('does not mistake the word "Bearer none" for a credential', () => {
    const input = 'auth header was Bearer none';
    assert.equal(redactEvidence(input), input);
  });

  it('leaves an empty string empty', () => {
    assert.equal(redactEvidence(''), '');
  });
});

describe('redactEvidence — defensive coercion', () => {
  it('returns an empty string for non-string input', () => {
    assert.equal(redactEvidence(null), '');
    assert.equal(redactEvidence(undefined), '');
    assert.equal(redactEvidence(42), '');
    assert.equal(redactEvidence({ token: 'leak-me' }), '');
  });
});
