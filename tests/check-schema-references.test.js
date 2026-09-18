/**
 * tests/check-schema-references.test.js — the orphan-schema gate (Story #4938).
 *
 * A JSON Schema that exists and parses is read as an enforced contract. That
 * inference is normally right, which is exactly what makes it dangerous when
 * it is wrong: `friction-event.schema.json` sat in `.agents/schemas/` with no
 * compiler from the Epic #4406 envelope cutover until Story #4938, and in
 * between an `/audit-documentation` lens graded a High finding against it as
 * the live contract. The finding became an acceptance criterion on another
 * Story, and the delivering worker had to overrule that criterion to avoid
 * writing a payload the real validator drops. Two verification layers waved it
 * through on existence plus valid syntax alone.
 *
 * The gate is the code read that would have caught it. Three properties have
 * to hold, and none is self-enforcing:
 *
 *   1. It FAILS when an uncompiled schema is added — a gate that only reports
 *      is one nobody notices.
 *   2. It PASSES on this repository, so the check is live rather than a
 *      permanently-red fixture everyone learns to ignore.
 *   3. Prose is not a compile. A docblock naming a schema — including this
 *      gate's own header, which names the dead one repeatedly — must not
 *      count as a reference, or the gate certifies itself.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { makeTempDir } from '../.agents/scripts/lib/test-temp.js';
import {
  auditSchemaReferences,
  main,
  parseArgv,
} from '../scripts/check-schema-references.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

const tempRoots = [];

/**
 * Build a throwaway repo-shaped fixture: schemas under `.agents/schemas/`
 * plus arbitrary JS sources that may or may not reference them.
 *
 * @param {{ schemas?: Record<string, object>, sources?: Record<string, string> }} spec
 * @returns {string} absolute fixture root
 */
function makeFixture({ schemas = {}, sources = {} } = {}) {
  const root = makeTempDir('schema-references-');
  tempRoots.push(root);
  for (const [rel, doc] of Object.entries(schemas)) {
    const full = path.join(root, '.agents', 'schemas', rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, `${JSON.stringify(doc, null, 2)}\n`);
  }
  for (const [rel, text] of Object.entries(sources)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, text);
  }
  return root;
}

/** A minimal well-formed draft-07 document. */
const SCHEMA_BODY = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  type: 'object',
};

after(() => {
  for (const root of tempRoots)
    fs.rmSync(root, { recursive: true, force: true });
});

describe('the gate fails when an uncompiled schema is added', () => {
  it('reports a schema no source mentions', () => {
    const root = makeFixture({
      schemas: { 'orphan.schema.json': SCHEMA_BODY },
    });
    const report = auditSchemaReferences({ root });
    assert.deepEqual(
      report.findings.map((f) => f.schema),
      [path.join('.agents', 'schemas', 'orphan.schema.json')],
    );
  });

  it('clears a schema a source loads by literal basename', () => {
    const root = makeFixture({
      schemas: { 'wired.schema.json': SCHEMA_BODY },
      sources: {
        'lib/load.js': "const p = 'wired.schema.json';\nexport default p;\n",
      },
    });
    const report = auditSchemaReferences({ root });
    assert.deepEqual(report.findings, []);
    assert.equal(report.referenced, 1);
  });

  it('does not accept a mention in a comment as a compile', () => {
    const root = makeFixture({
      schemas: { 'orphan.schema.json': SCHEMA_BODY },
      sources: {
        // Both comment shapes, since the gate's own header uses the block form
        // and would otherwise resolve the very file it was written to report.
        'lib/prose.js':
          '/** Payload matching `orphan.schema.json`. */\n' +
          '// see orphan.schema.json for the shape\n' +
          'export const noop = () => {};\n',
      },
    });
    const report = auditSchemaReferences({ root });
    assert.equal(
      report.findings.length,
      1,
      'a docblock citation was mistaken for an enforced reference',
    );
  });

  it('leaves a `//` inside a URL alone when stripping line comments', () => {
    const root = makeFixture({
      schemas: { 'wired.schema.json': SCHEMA_BODY },
      sources: {
        'lib/load.js':
          "const id = 'http://example.test/x'; const p = 'wired.schema.json';\n",
      },
    });
    assert.deepEqual(auditSchemaReferences({ root }).findings, []);
  });
});

describe('dynamic directory loading', () => {
  // Fixture source the gate must recognize as a computed schema path. Written
  // as a template literal with the interpolation escaped, so the `${…}` lands
  // in the fixture text verbatim rather than being evaluated here.
  const dynamicSource = `const dir = path.join(root, 'schemas', 'events');
const p = path.join(dir, \`\${event}.schema.json\`);
`;

  it('clears a schema whose stem is the runtime key of a computed path', () => {
    const root = makeFixture({
      schemas: { 'events/story.merged.schema.json': SCHEMA_BODY },
      sources: {
        'lib/bus.js': dynamicSource,
        'lib/emit.js': "bus.emit('story.merged', payload);\n",
      },
    });
    assert.deepEqual(auditSchemaReferences({ root }).findings, []);
  });

  it('still reports a schema dropped into that directory with no key', () => {
    const root = makeFixture({
      schemas: { 'events/never.emitted.schema.json': SCHEMA_BODY },
      sources: { 'lib/bus.js': dynamicSource },
    });
    assert.equal(
      auditSchemaReferences({ root }).findings.length,
      1,
      'the directory evidence alone blessed a file nothing emits',
    );
  });

  it('does not offer dynamic resolution to schemas at the schema root', () => {
    const root = makeFixture({
      schemas: { 'story.merged.schema.json': SCHEMA_BODY },
      sources: {
        'lib/bus.js': dynamicSource,
        'lib/emit.js': "bus.emit('story.merged', payload);\n",
      },
    });
    assert.equal(auditSchemaReferences({ root }).findings.length, 1);
  });
});

describe('in-file exemption', () => {
  it('accepts a root x-mandrel-uncompiled block and reports it as exempt', () => {
    const root = makeFixture({
      schemas: {
        'documented.schema.json': {
          ...SCHEMA_BODY,
          'x-mandrel-uncompiled': {
            reason: 'Documented SSOT; enforced by a hand-rolled guard.',
            runtimeGate: 'lib/guard.js#validate',
          },
        },
      },
    });
    const report = auditSchemaReferences({ root });
    assert.deepEqual(report.findings, []);
    assert.equal(report.exempt.length, 1);
    assert.equal(report.exempt[0].runtimeGate, 'lib/guard.js#validate');
  });

  it('rejects an empty reason — silence is what the gate exists to stop', () => {
    const root = makeFixture({
      schemas: {
        'documented.schema.json': {
          ...SCHEMA_BODY,
          'x-mandrel-uncompiled': { reason: '   ' },
        },
      },
    });
    assert.equal(auditSchemaReferences({ root }).findings.length, 1);
  });
});

describe('the CLI surface', () => {
  /** Run `main` with stdout captured. */
  async function run(argv) {
    const original = process.stdout.write;
    let out = '';
    process.stdout.write = (chunk) => {
      out += chunk;
      return true;
    };
    try {
      return { code: await main(argv), out };
    } finally {
      process.stdout.write = original;
    }
  }

  it('parses --root and --json, defaulting to cwd and text', () => {
    assert.deepEqual(parseArgv([]), { root: process.cwd(), json: false });
    const parsed = parseArgv(['--json', '--root', '.']);
    assert.equal(parsed.json, true);
    assert.equal(parsed.root, path.resolve('.'));
  });

  it('ignores a trailing --root with no value rather than crashing', () => {
    assert.equal(parseArgv(['--root']).root, process.cwd());
  });

  it('exits 1 and names the offender when a schema is uncompiled', async () => {
    const root = makeFixture({
      schemas: { 'orphan.schema.json': SCHEMA_BODY },
    });
    const { code, out } = await run(['--root', root]);
    assert.equal(code, 1);
    assert.match(out, /orphan\.schema\.json/);
    assert.match(out, /x-mandrel-uncompiled/);
  });

  it('exits 0 with a single-line JSON envelope under --json', async () => {
    const root = makeFixture({
      schemas: { 'wired.schema.json': SCHEMA_BODY },
      sources: { 'lib/load.js': "const p = 'wired.schema.json';\n" },
    });
    const { code, out } = await run(['--root', root, '--json']);
    assert.equal(code, 0);
    assert.equal(
      out.trimEnd().includes('\n'),
      false,
      'envelope must be one line',
    );
    assert.deepEqual(JSON.parse(out), {
      schemaCount: 1,
      referenced: 1,
      exempt: [],
      findings: [],
    });
  });
});

describe('this repository', () => {
  const report = auditSchemaReferences({ root: REPO_ROOT });

  it('has no schema that nothing compiles', () => {
    assert.deepEqual(
      report.findings.map((f) => f.schema),
      [],
      'add the compiler, delete the schema, or declare x-mandrel-uncompiled in it',
    );
  });

  it('records every exemption in the schema file itself, with a reason', () => {
    for (const entry of report.exempt) {
      assert.ok(
        entry.reason.length > 20,
        `${entry.schema} claims an exemption without explaining it`,
      );
      const doc = JSON.parse(
        fs.readFileSync(path.join(REPO_ROOT, entry.schema), 'utf8'),
      );
      assert.ok(
        doc['x-mandrel-uncompiled'],
        `${entry.schema} was reported exempt but carries no in-file marker`,
      );
    }
  });

  it('no longer ships the retired friction-event schema', () => {
    assert.equal(
      fs.existsSync(
        path.join(
          REPO_ROOT,
          '.agents',
          'schemas',
          'friction-event.schema.json',
        ),
      ),
      false,
      'friction-event.schema.json is retired — its shape lives in docs/archive/data-dictionary-2026-08.md',
    );
  });

  it('leaves the enforced signal path compiling signal-event.schema.json', () => {
    const validator = fs.readFileSync(
      path.join(
        REPO_ROOT,
        '.agents',
        'scripts',
        'lib',
        'observability',
        'signal-validator.js',
      ),
      'utf8',
    );
    assert.match(validator, /'signal-event\.schema\.json'/);
  });
});
