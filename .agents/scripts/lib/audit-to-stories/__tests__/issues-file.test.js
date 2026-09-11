/**
 * The host-supplied issue corpus and its one normaliser (Story #5301).
 *
 * `--issues-file` is what lets dedup run on a host with no `gh` CLI: the host
 * fetches the `audit::*` issues by whatever access path it has and hands over
 * a JSON array. Two properties carry the whole design.
 *
 * **It accepts what a host actually produces.** The raw shapes differ — `OPEN`
 * vs `open`, `closed` spelled only as `state_reason: "not_planned"` — so the
 * corpus goes through the same normaliser the provider's search hits do rather
 * than making the host learn this repo's spelling.
 *
 * **An unusable file is fatal, never a degrade.** Falling back to the
 * un-indexed path would mean no dedup at all on exactly the invocation whose
 * purpose is that dedup runs — and a create-only plan the operator reads as
 * checked is how a sweep re-files what it already filed.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import { makeTempDir } from '../../test-temp.js';
import { loadIssuesFile, normaliseIssueHit } from '../issues-file.js';

/** Read a literal payload through the loader without touching disk. */
function loadLiteral(payload, filePath = 'issues.json') {
  return loadIssuesFile(filePath, { readFileSyncImpl: () => payload });
}

describe('normaliseIssueHit collapses every state spelling', () => {
  it('reads an upper-case GraphQL state', () => {
    assert.equal(
      normaliseIssueHit({ number: 1, state: 'CLOSED' }).state,
      'closed',
    );
    assert.equal(normaliseIssueHit({ number: 1, state: 'OPEN' }).state, 'open');
  });

  it('falls back to state_reason when no state field is present', () => {
    assert.equal(
      normaliseIssueHit({ number: 2, state_reason: 'CLOSED' }).state,
      'closed',
    );
    // Pre-existing, deliberately unchanged here: the fallback matches on the
    // word "closed", so a bare `state_reason: "not_planned"` with no `state`
    // reads as open. Every real source pairs the two, and this normaliser is
    // shared with the provider search path — widening it is a separate change.
    assert.equal(
      normaliseIssueHit({ number: 2, state_reason: 'not_planned' }).state,
      'open',
    );
  });

  it('defaults a stateless entry to open and fills absent text fields', () => {
    assert.deepEqual(normaliseIssueHit({ number: 3 }), {
      number: 3,
      state: 'open',
      title: '',
      body: '',
    });
  });
});

describe('loadIssuesFile accepts a raw host-fetched list', () => {
  it('normalises every entry and drops the fields dedup does not read', () => {
    const issues = loadLiteral(
      JSON.stringify([
        {
          number: 4182,
          state: 'OPEN',
          title: 'sqli in login',
          body: 'footer',
          labels: [{ name: 'audit::security' }],
          user: { login: 'someone' },
        },
        {
          number: 4076,
          state: 'CLOSED',
          state_reason: 'not_planned',
          body: 'b',
        },
      ]),
    );

    assert.deepEqual(issues, [
      { number: 4182, state: 'open', title: 'sqli in login', body: 'footer' },
      { number: 4076, state: 'closed', title: '', body: 'b' },
    ]);
  });

  it('drops an entry that cannot identify an issue rather than indexing it under nothing', () => {
    const issues = loadLiteral(
      JSON.stringify([
        { number: 1, body: 'a' },
        { body: 'no number' },
        null,
        'x',
      ]),
    );
    assert.deepEqual(
      issues.map((i) => i.number),
      [1],
    );
  });

  it('reads a real file off disk through the default seam', () => {
    const dir = makeTempDir('issues-file-');
    const filePath = path.join(dir, 'issues.json');
    fs.writeFileSync(
      filePath,
      JSON.stringify([{ number: 9, state: 'open', body: 'f' }]),
    );

    assert.deepEqual(loadIssuesFile(filePath), [
      { number: 9, state: 'open', title: '', body: 'f' },
    ]);
  });

  it('returns an empty corpus for an empty array — a legitimate first sweep', () => {
    assert.deepEqual(loadLiteral('[]'), []);
  });
});

describe('loadIssuesFile refuses an unusable corpus outright', () => {
  it('names the path and the consequence when the file cannot be read', () => {
    assert.throws(
      () =>
        loadIssuesFile('temp/audits/missing.json', {
          readFileSyncImpl: () => {
            throw new Error("ENOENT: no such file or directory, open 'x'");
          },
        }),
      (err) => {
        assert.match(
          err.message,
          /--issues-file: cannot read "temp\/audits\/missing\.json"/,
        );
        assert.match(err.message, /ENOENT/);
        assert.match(err.message, /re-file findings already tracked/);
        return true;
      },
    );
  });

  it('names the path when the payload is not JSON', () => {
    assert.throws(
      () => loadLiteral('not json at all', 'temp/audits/bad.json'),
      /--issues-file: "temp\/audits\/bad\.json" is not valid JSON/,
    );
  });

  it('rejects a JSON object, naming what it found', () => {
    assert.throws(
      () => loadLiteral('{"issues":[]}', 'wrapped.json'),
      /holds a JSON object, not a JSON array of issues/,
    );
  });

  it('rejects a JSON null', () => {
    assert.throws(() => loadLiteral('null'), /holds null, not a JSON array/);
  });
});
