/**
 * tests/check-pinned-override-notes.test.js — Story #5248.
 *
 * The `"//"` note on a pinned override is read at exactly one moment: when
 * someone is deciding whether bumping it is safe. It had drifted two bumps
 * behind the pin it describes, and nothing noticed. These tests pin the two
 * claims the notes themselves make — the stated version is the version in
 * force, and the override range and the direct range move in lockstep.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { runCheck } from '../.agents/scripts/check-pinned-override-notes.js';
import { auditPinnedOverrideNotes } from '../.agents/scripts/lib/pinned-override-notes.js';

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

const kinds = (pkg) =>
  auditPinnedOverrideNotes(pkg).findings.map((f) => f.kind);

const pkgWith = ({ note, override, direct }) => ({
  '//': { 'overrides.demo': note },
  overrides: { demo: override },
  ...(direct === undefined ? {} : { dependencies: { demo: direct } }),
});

// Range extraction is an implementation detail, exercised through the audit
// it serves. What matters is that a note quoting the range in force is never
// scored — whatever OTHER versions it cites as history ("pulls js-yaml 4.1.1",
// "declares an exact 5.2.1"), and whether or not the range in force carries a
// prefix. An exact pin used to be invisible to the matcher entirely, which
// exempted its note from the guarantee (Story #5281).
describe('range extraction, through the audit', () => {
  it('is satisfied by the range in force among versions cited as history', () => {
    assert.deepEqual(
      kinds(
        pkgWith({
          note: 'pins ^4.3.2 because 4.1.1 and 5.2.1 are bad',
          override: '^4.3.2',
        }),
      ),
      [],
    );
  });

  it('reads a tilde range as a claim just as it reads a caret', () => {
    assert.deepEqual(
      kinds(pkgWith({ note: 'pins ~2.0.0', override: '^4.3.2' })),
      ['stale-note'],
    );
  });

  it('treats a non-string note as quoting nothing', () => {
    assert.deepEqual(
      kinds(pkgWith({ note: undefined, override: '^1.0.0' })),
      [],
    );
  });
});

describe('auditPinnedOverrideNotes', () => {
  it('passes when the note states the pin in force', () => {
    const report = auditPinnedOverrideNotes(
      pkgWith({ note: 'tree-wide ^4.3.2 is imposed', override: '^4.3.2' }),
    );
    assert.deepEqual(report.findings, []);
    assert.deepEqual(report.checked, ['demo']);
  });

  it('flags a note left behind by a bump', () => {
    const report = auditPinnedOverrideNotes(
      pkgWith({ note: 'tree-wide ^4.2.0 is imposed', override: '^4.3.2' }),
    );
    assert.deepEqual(
      report.findings.map((f) => f.kind),
      ['stale-note'],
    );
    assert.match(report.findings[0].detail, /\^4\.2\.0/);
    assert.match(report.findings[0].detail, /\^4\.3\.2/);
  });

  it('flags a broken lockstep between the override and the direct range', () => {
    assert.deepEqual(
      kinds(
        pkgWith({ note: 'pins ^4.3.2', override: '^4.3.2', direct: '^4.3.1' }),
      ),
      ['lockstep'],
    );
  });

  it('reports both when a bump moved one range and neither the note', () => {
    assert.deepEqual(
      kinds(
        pkgWith({ note: 'pins ^4.2.0', override: '^4.3.2', direct: '^4.3.1' }),
      ),
      ['lockstep', 'stale-note'],
    );
  });

  it('flags a safety note left behind for a pin that is gone', () => {
    assert.deepEqual(
      kinds({ '//': { 'overrides.demo': 'pins ^1.0.0' }, overrides: {} }),
      ['orphan-note'],
    );
  });

  // Prose that names no version cannot go stale, and forcing every note to
  // quote one would make the notes unwritable.
  it('does not score a note that quotes no range', () => {
    assert.deepEqual(
      kinds(pkgWith({ note: 'do not drop this override', override: '^4.3.2' })),
      [],
    );
  });

  it('ignores "//" keys that do not document an override', () => {
    const report = auditPinnedOverrideNotes({
      '//': { 'peerDependencies.thing': 'says ^9.9.9' },
      overrides: {},
    });
    assert.deepEqual(report.findings, []);
    assert.deepEqual(report.checked, []);
  });

  it('tolerates a package with no notes, overrides or dependencies', () => {
    assert.deepEqual(auditPinnedOverrideNotes({}).findings, []);
    assert.deepEqual(auditPinnedOverrideNotes(undefined).findings, []);
  });
});

describe('runCheck — exit codes', () => {
  const silent = { info: () => {}, warn: () => {}, error: () => {} };
  const argv = (...f) => ['node', 'check-pinned-override-notes.js', ...f];

  it('exits 0 on a tree whose notes match', () => {
    assert.equal(
      runCheck(argv(), {
        readPackage: () => pkgWith({ note: 'pins ^4.3.2', override: '^4.3.2' }),
        logger: silent,
      }),
      0,
    );
  });

  it('exits 1 on drift', () => {
    assert.equal(
      runCheck(argv(), {
        readPackage: () => pkgWith({ note: 'pins ^4.2.0', override: '^4.3.2' }),
        logger: silent,
      }),
      1,
    );
  });

  it('exits 2 — not 1 — when the package cannot be read', () => {
    assert.equal(
      runCheck(argv(), {
        readPackage: () => {
          throw new Error('ENOENT');
        },
        logger: silent,
      }),
      2,
    );
  });

  it('--json emits the report and keeps the drift verdict', () => {
    const out = [];
    const code = runCheck(argv('--json'), {
      readPackage: () => pkgWith({ note: 'pins ^4.2.0', override: '^4.3.2' }),
      logger: { ...silent, info: (m) => out.push(m) },
    });
    assert.equal(code, 1);
    assert.equal(JSON.parse(out.join('')).findings[0].kind, 'stale-note');
  });
});

describe('the committed package.json', () => {
  it('has notes that match their pins', () => {
    const pkg = JSON.parse(
      readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'),
    );
    assert.deepEqual(auditPinnedOverrideNotes(pkg).findings, []);
  });

  // The regression this Story was filed for: the note said ^4.2.0 while the
  // pin had moved to ^4.3.2, and the lockstep claim was unenforced.
  it('keeps the js-yaml override and direct range in lockstep', () => {
    const pkg = JSON.parse(
      readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'),
    );
    assert.equal(pkg.overrides['js-yaml'], pkg.dependencies['js-yaml']);
    assert.ok(
      pkg['//']['overrides.js-yaml'].includes(pkg.overrides['js-yaml']),
    );
  });
});

// --- Story #5281: the shapes an npm-native overrides block actually carries ---

describe('npm-native override shapes', () => {
  it('resolves a "$name" reference to the direct range it points at', () => {
    const report = auditPinnedOverrideNotes({
      '//': { 'overrides.demo': 'tree-wide ^4.3.2 is imposed' },
      overrides: { demo: '$demo' },
      dependencies: { demo: '^4.3.2' },
    });
    // Nothing to flag: npm resolves the override TO the direct range, so the
    // pair the note warns about cannot split, and the note quotes the range in
    // force.
    assert.deepEqual(report.findings, []);
    assert.deepEqual(report.checked, ['demo']);
  });

  it('a "$name" reference is never a lockstep split, whatever the raw strings say', () => {
    assert.deepEqual(
      kinds({
        '//': { 'overrides.demo': 'pins ^4.3.2' },
        overrides: { demo: '$demo' },
        dependencies: { demo: '^4.3.2' },
      }),
      [],
    );
  });

  it('still scores a reference whose resolved range the note has outrun', () => {
    assert.deepEqual(
      kinds({
        '//': { 'overrides.demo': 'pins ^4.2.0' },
        overrides: { demo: '$demo' },
        dependencies: { demo: '^4.3.2' },
      }),
      ['stale-note'],
    );
  });

  it('a nested override object is an unsupported shape, not an orphan note', () => {
    const report = auditPinnedOverrideNotes({
      '//': { 'overrides.parent': 'pins ^1.0.0' },
      overrides: { parent: { demo: '^1.0.0' } },
    });
    assert.deepEqual(
      report.findings.map((f) => f.kind),
      ['unsupported-shape'],
    );
    assert.match(report.findings[0].detail, /leaf/);
  });

  it('reads a note keyed at the leaf of a nested override', () => {
    assert.deepEqual(
      kinds({
        '//': { 'overrides.parent.demo': 'pins ^1.0.0' },
        overrides: { parent: { demo: '^1.0.0' } },
      }),
      [],
    );
  });

  it('a dangling "$name" reference names the missing dependency', () => {
    const report = auditPinnedOverrideNotes({
      '//': { 'overrides.demo': 'pins ^1.0.0' },
      overrides: { demo: '$demo' },
      dependencies: {},
    });
    assert.deepEqual(
      report.findings.map((f) => f.kind),
      ['unsupported-shape'],
    );
    assert.match(
      report.findings[0].detail,
      /dependencies\.demo does not exist/,
    );
  });

  it('matches a note quoting an exact pin', () => {
    assert.deepEqual(
      kinds(pkgWith({ note: 'pinned at exactly 1.2.3', override: '1.2.3' })),
      [],
    );
  });

  it('still flags a note quoting the wrong exact pin', () => {
    assert.deepEqual(
      kinds(pkgWith({ note: 'pinned at exactly 1.2.2', override: '1.2.3' })),
      ['stale-note'],
    );
  });
});
