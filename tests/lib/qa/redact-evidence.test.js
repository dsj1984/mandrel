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

/**
 * Story #3737 — broaden the rule set to the full security-baseline secret/PII
 * taxonomy: passwords, API keys, credit-card numbers (PANs), and SSNs, on top
 * of the original bearer / cookie / email rules. Each class gets a positive
 * (value scrubbed, placeholder substituted) and a negative (benign look-alike
 * passes through) case.
 */
describe('redactEvidence — passwords', () => {
  it('scrubs password assignments in =, :, and JSON shapes', () => {
    for (const input of [
      'password=hunter2SuperSecret',
      'pwd: hunter2SuperSecret',
      '{"password": "hunter2SuperSecret"}',
      'passwd=hunter2SuperSecret',
    ]) {
      const output = redactEvidence(input);
      assert.ok(
        !output.includes('hunter2SuperSecret'),
        `password value must not survive in: ${input}`,
      );
      assert.ok(
        output.includes(REDACTION_PLACEHOLDERS.password),
        `password placeholder must be substituted for: ${input}`,
      );
    }
  });

  it('preserves the JSON key quoting around a redacted password', () => {
    const output = redactEvidence('{"password": "topsecret123"}');
    assert.ok(output.includes('"password"'), 'key is preserved');
    assert.ok(output.includes(`"${REDACTION_PLACEHOLDERS.password}"`));
  });

  it('does not redact a benign word ending in "password"-like text', () => {
    const benign = 'the password field is required';
    assert.equal(redactEvidence(benign), benign);
  });
});

describe('redactEvidence — API keys', () => {
  it('scrubs provider-prefixed API keys whole', () => {
    // Built by concatenation rather than as source literals so the synthetic
    // fixtures exercise the prefix patterns without tripping repository
    // push-protection / secret-scanning on a look-alike provider key.
    const body = 'AbCdEfGhIjKlMnOpQrStUvWx0123456789';
    for (const key of [
      `sk_live_${body}`,
      `pk_test_${body}`,
      `ghp_${body}`,
      `AIza${body}${body}`,
      `AKIA${'ABCDEFGH12345678'}`,
    ]) {
      const output = redactEvidence(`token used: ${key}`);
      assert.ok(!output.includes(key), `API key must not survive: ${key}`);
      assert.ok(output.includes(REDACTION_PLACEHOLDERS.apiKey));
    }
  });

  it('scrubs generic api_key / access-token assignments', () => {
    for (const input of [
      'api_key=abcd1234efgh5678',
      'apikey: "abcd1234efgh5678"',
      'access-token=abcd1234efgh5678',
      'secret_key=abcd1234efgh5678',
    ]) {
      const output = redactEvidence(input);
      assert.ok(
        !output.includes('abcd1234efgh5678'),
        `api-key value must not survive in: ${input}`,
      );
      assert.ok(output.includes(REDACTION_PLACEHOLDERS.apiKey));
    }
  });

  it('leaves a benign short identifier matching no api-key shape unchanged', () => {
    const benign = 'monkey=banana';
    assert.equal(redactEvidence(benign), benign);
  });
});

describe('redactEvidence — credit-card numbers (PANs)', () => {
  it('scrubs 13–19 digit PANs with and without separators', () => {
    for (const pan of [
      '4111111111111111',
      '4111 1111 1111 1111',
      '4111-1111-1111-1111',
      '378282246310005',
    ]) {
      const output = redactEvidence(`card on file: ${pan}`);
      assert.ok(!output.includes(pan), `PAN must not survive: ${pan}`);
      assert.ok(output.includes(REDACTION_PLACEHOLDERS.creditCard));
    }
  });

  it('does not redact a short numeric id that is not a PAN', () => {
    const benign = 'order id 12345 placed at 09:30';
    assert.equal(redactEvidence(benign), benign);
  });
});

describe('redactEvidence — SSNs', () => {
  it('scrubs an NNN-NN-NNNN social security number', () => {
    const output = redactEvidence('ssn on file: 123-45-6789');
    assert.ok(!output.includes('123-45-6789'), 'SSN must not survive');
    assert.ok(output.includes(REDACTION_PLACEHOLDERS.ssn));
  });

  it('does not treat a bare 9-digit run as an SSN', () => {
    const benign = 'reference number 123456789 logged';
    assert.equal(redactEvidence(benign), benign);
  });
});

describe('redactEvidence — M1 cookie over-redaction fix', () => {
  it('does not over-redact a benign name=value pair whose name merely contains a session word', () => {
    for (const benign of [
      'author=Jane',
      'outside=cold',
      'presidency=2024',
      'tokenizer=bpe',
      'consideration=high',
    ]) {
      assert.equal(
        redactEvidence(benign),
        benign,
        `${benign} must pass through unchanged`,
      );
    }
  });

  it('still redacts a true session cookie whose name is a delimited session segment', () => {
    for (const name of [
      'sessionId',
      'connect.sid',
      'auth_token',
      'JSESSIONID',
      'csrf_token',
      'x-xsrf-token'.replace('-', '_'),
    ]) {
      const output = redactEvidence(`${name}=deadbeefcafe1234`);
      assert.ok(
        !output.includes('deadbeefcafe1234'),
        `value of ${name} must be redacted`,
      );
      assert.ok(output.includes(REDACTION_PLACEHOLDERS.cookie));
    }
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
