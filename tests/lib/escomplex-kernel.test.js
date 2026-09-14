/**
 * Parity suite for the in-repo complexity kernel (Story #5333).
 *
 * The kernel this replaced — `typhonjs-escomplex` — is no longer installed, so
 * there is nothing left to diff against at runtime. The evidence is instead a
 * corpus captured under that kernel *before* the dependency swap and committed
 * on its own (see `tests/fixtures/escomplex-kernel-parity/provenance.json` for
 * the capturing SHA). These tests replay it.
 *
 * Two guards make the corpus trustworthy rather than merely present:
 *
 * - the corpus must hash to the digest recorded at capture time, so it cannot
 *   be silently re-written to match a kernel that drifted;
 * - the running `@babel/parser` major must equal the one recorded at capture
 *   time. The parser IS the kernel's front end, so replaying the corpus under
 *   a different major would compare two different kernels and call the result
 *   parity. A mismatch fails loudly here rather than skipping quietly.
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';
import { methodRowsFromReport } from '../../.agents/scripts/lib/crap-engine.js';
import { analyzeModule } from '../../.agents/scripts/lib/escomplex-kernel.js';
import { describeParserMajorError } from '../../.agents/scripts/lib/runtime-deps/parser-major.js';
import {
  projectMetrics,
  reportHash,
  syntheticCoverageEntry,
} from '../fixtures/escomplex-kernel-parity/synthetic-coverage.js';

const FIXTURE_DIR = new URL(
  '../fixtures/escomplex-kernel-parity/',
  import.meta.url,
);

const corpusRaw = fs.readFileSync(new URL('corpus.json', FIXTURE_DIR), 'utf-8');
const corpus = JSON.parse(corpusRaw);
const provenance = JSON.parse(
  fs.readFileSync(new URL('provenance.json', FIXTURE_DIR), 'utf-8'),
);

/**
 * Score one fixture through the kernel under test and project it onto the same
 * shape the capture recorded — including the thrown-error shape, so a
 * construct the displaced kernel could not handle must still not be handled.
 *
 * @param {string} source
 * @returns {object}
 */
function scoreFixture(source) {
  let report;
  try {
    report = analyzeModule(source);
  } catch (err) {
    return { error: `${err.constructor.name}: ${err.message}` };
  }
  return {
    reportHash: reportHash(report),
    metrics: projectMetrics(report),
    crapRows: methodRowsFromReport(report, syntheticCoverageEntry(report)),
  };
}

describe('escomplex-kernel — corpus preconditions', () => {
  it('replays against the parser major the corpus was captured under', () => {
    // Resolved here rather than asked of the module under test: the precondition
    // is about the tree this replay runs in, and a test that takes the subject's
    // word for its own inputs can be fooled by the subject.
    const parserManifest = JSON.parse(
      fs.readFileSync(
        createRequire(import.meta.url).resolve('@babel/parser/package.json'),
        'utf-8',
      ),
    );
    const running = Number.parseInt(parserManifest.version, 10);
    assert.equal(
      running,
      provenance.parser.major,
      `parity corpus was captured under @babel/parser ${provenance.parser.version} ` +
        `(major ${provenance.parser.major}) and the running major is ${running}. ` +
        'The parser is the kernel front end, so this corpus cannot certify ' +
        'this kernel — the scores need a deliberate recut, not a replay.',
    );
  });

  it('has not been re-written since capture', () => {
    const digest = crypto
      .createHash('sha256')
      .update(corpusRaw.replace(/\n$/, ''))
      .digest('hex');
    assert.equal(
      digest,
      provenance.corpusSha256,
      'corpus.json no longer hashes to the digest recorded at capture time',
    );
  });

  it('records the provenance that makes it interpretable', () => {
    assert.equal(provenance.displacedKernel.name, 'typhonjs-escomplex');
    assert.match(provenance.displacedKernel.version, /^\d+\.\d+\.\d+/);
    assert.equal(provenance.astCompatInstall.available, true);
    assert.ok(provenance.astCompatInstall.applied.length > 0);
    assert.match(provenance.capturedAtSha, /^[0-9a-f]{40}$/);
    assert.equal(provenance.fixtureCount, corpus.fixtures.length);
  });

  it('covers both real sources and adversarial constructs', () => {
    const names = corpus.fixtures.map((f) => f.name);
    assert.ok(names.filter((n) => n.startsWith('repo/')).length >= 20);
    assert.ok(names.filter((n) => n.startsWith('edge/')).length >= 25);
    // A corpus with no recorded failure would not pin failure-mode parity.
    assert.ok(provenance.throwingFixtureCount > 0);
  });
});

describe('escomplex-kernel — report parity with the displaced kernel', () => {
  for (const fixture of corpus.fixtures) {
    it(`reproduces ${fixture.name}`, () => {
      const actual = scoreFixture(fixture.source);
      assert.equal(
        actual.error,
        fixture.error,
        `${fixture.name}: thrown-error parity`,
      );
      assert.equal(
        actual.reportHash,
        fixture.reportHash,
        `${fixture.name}: whole-report hash moved — the projection below names ` +
          'which dimension',
      );
      assert.deepEqual(
        actual.metrics,
        fixture.metrics,
        `${fixture.name}: maintainability / cyclomatic / line coordinates`,
      );
      assert.deepEqual(
        actual.crapRows,
        fixture.crapRows,
        `${fixture.name}: per-method CRAP rows`,
      );
    });
  }
});

describe('escomplex-kernel — modern JavaScript still scores', () => {
  // AC-4's other half: the astSyntax repairs are what keep these from
  // aborting a whole module. If the compat patch stopped binding the copy the
  // traversal reads, these regress to a thrown error and this fails — which
  // is the point of asserting it here rather than only in the compat suite.
  const SCORED = [
    'edge/regexForOf',
    'edge/awaitForOf',
    'edge/optChainForOf',
    'edge/dynImportDefault',
    'edge/spreadDefault',
    'edge/objMethodDefault',
    'edge/classDefault',
  ];

  for (const name of SCORED) {
    it(`scores ${name} instead of aborting the module`, () => {
      const fixture = corpus.fixtures.find((f) => f.name === name);
      assert.ok(fixture, `${name} missing from the corpus`);
      assert.equal(
        fixture.error,
        undefined,
        `${name} was captured as throwing`,
      );
      const report = analyzeModule(fixture.source);
      assert.equal(typeof report.maintainability, 'number');
      assert.ok(report.maintainability > 0);
    });
  }
});

describe('escomplex-kernel — parser major guard', () => {
  it('accepts the parser major this tree resolves', () => {
    // The supported major is module-local — the verdict is the public answer,
    // so a supported tree is asserted as "no problem to report" rather than by
    // re-stating the number the module owns.
    assert.equal(
      describeParserMajorError(),
      null,
      'the declared ^7 range must resolve a parser this kernel supports',
    );
  });

  it('names the package, the resolved version and the remedy', () => {
    const message = describeParserMajorError({
      major: 8,
      version: '8.0.5',
    });
    assert.ok(message, 'an unsupported major must produce a message');
    assert.match(message, /@babel\/parser/);
    assert.match(message, /resolved 8\.0\.5/);
    assert.match(message, /requires 7\.x/);
    assert.match(message, /plugin-list/);
    assert.match(message, /runtime-deps\.json/);
  });

  it('treats an unknowable version as supported rather than fatal', () => {
    assert.equal(
      describeParserMajorError({ major: null, version: null }),
      null,
      'a layout that hides the manifest still resolves the parser itself',
    );
  });
});
