/**
 * lib/audit-suite/__tests__/applicability-probe.test.js — the persistence-layer
 * applicability probe behind the `target: "data-model"` gate (Story #4633).
 *
 * The `audit-data-model` lens reads a persistence layer (ORM models, schema
 * migrations, seed data). A project with none of those has nothing for it to
 * inspect, so the lens must resolve **not applicable** and skip cleanly rather
 * than run to empty findings. This suite pins that behaviour on both surfaces:
 *
 *   - `hasPersistenceLayer` — the pure probe: not-applicable for a repo with no
 *     ORM dependency / migrations directory / schema files, applicable for a
 *     fixture with a database migrations dir or a schema file, and — the
 *     load-bearing self-skip — not-applicable for the Mandrel checkout itself
 *     (which ships a `lib/migrations/` of framework-version upgrade steps that
 *     must NOT be mistaken for a database migrations directory).
 *   - `selectAudits` — the routing gate: `audit-data-model` is filtered out of
 *     the selected roster for the Mandrel checkout even when the change set
 *     matches its `filePatterns`, and IS selected once the probe reports a
 *     persistence layer.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  _resetPersistenceLayerCache,
  hasPersistenceLayer,
  selectAudits,
} from '../selector.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// __tests__ → audit-suite → lib → scripts → .agents → repo root
const MANDREL_ROOT = path.resolve(__dirname, '..', '..', '..', '..', '..');

/** Create a throwaway fixture repo root, applying `build(root)` to populate it. */
function makeFixture(build) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'data-model-probe-'));
  build(root);
  return root;
}

/** Write a file under `root`, creating parent directories as needed. */
function writeUnder(root, relPath, contents) {
  const abs = path.join(root, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, contents);
}

afterEach(() => {
  _resetPersistenceLayerCache();
});

describe('hasPersistenceLayer (Story #4633)', () => {
  it('resolves NOT applicable for a repo with no ORM / migrations / schema markers', () => {
    const root = makeFixture((r) => {
      writeUnder(
        r,
        'package.json',
        JSON.stringify({ name: 'db-less', dependencies: { picomatch: '^4' } }),
      );
      writeUnder(r, 'src/index.js', 'export const x = 1;\n');
      // A framework-migrations dir of JS steps (Mandrel's own shape) is NOT a
      // database migrations directory and must not be mistaken for one.
      writeUnder(r, 'lib/migrations/0001-step.js', 'export default {};\n');
    });
    assert.equal(hasPersistenceLayer({ projectRoot: root }), false);
  });

  it('resolves applicable for a fixture with a database migrations directory (JS steps under db/migrate)', () => {
    const root = makeFixture((r) => {
      writeUnder(
        r,
        'package.json',
        JSON.stringify({ name: 'with-migrations' }),
      );
      writeUnder(r, 'db/migrate/0001_init.js', 'exports.up = () => {};\n');
    });
    assert.equal(hasPersistenceLayer({ projectRoot: root }), true);
  });

  it('resolves applicable for a tracked .sql schema file', () => {
    const root = makeFixture((r) => {
      writeUnder(r, 'schema/001_init.sql', 'CREATE TABLE users (id int);\n');
    });
    assert.equal(hasPersistenceLayer({ projectRoot: root }), true);
  });

  it('resolves applicable for a tracked .prisma schema file', () => {
    const root = makeFixture((r) => {
      writeUnder(r, 'prisma/schema.prisma', 'model User { id Int @id }\n');
    });
    assert.equal(hasPersistenceLayer({ projectRoot: root }), true);
  });

  it('resolves applicable when package.json declares an ORM dependency', () => {
    const root = makeFixture((r) => {
      writeUnder(
        r,
        'package.json',
        JSON.stringify({
          name: 'orm-app',
          dependencies: { '@prisma/client': '^5' },
        }),
      );
    });
    assert.equal(hasPersistenceLayer({ projectRoot: root }), true);
  });

  it('fails OPEN when the ORM signal is indeterminate (unparseable package.json)', () => {
    const root = makeFixture((r) => {
      writeUnder(r, 'package.json', '{ this is not json');
    });
    assert.equal(hasPersistenceLayer({ projectRoot: root }), true);
  });

  it('self-skips: the Mandrel checkout resolves NOT applicable (AC-4)', () => {
    assert.equal(hasPersistenceLayer({ projectRoot: MANDREL_ROOT }), false);
  });
});

describe('selectAudits routing gate for audit-data-model (Story #4633)', () => {
  /** Minimal provider stub: selectAudits only calls getTicket. */
  const provider = {
    getTicket: async () => ({
      title: 'Add a destructive migration',
      body: 'Drops a column via a schema migration.',
    }),
  };

  it('filters audit-data-model out of the roster on the Mandrel checkout even when the change set matches its filePatterns (AC-4)', async () => {
    const { selectedAudits } = await selectAudits({
      ticketId: 1,
      gate: 'gate1',
      provider,
      changedFiles: ['db/migrate/0001_init.sql'],
    });
    assert.ok(
      !selectedAudits.includes('audit-data-model'),
      `expected audit-data-model to self-skip on a DB-less checkout; got ${selectedAudits.join(', ')}`,
    );
  });

  it('selects audit-data-model when the probe reports a persistence layer and the change set matches', async () => {
    const { selectedAudits } = await selectAudits({
      ticketId: 1,
      gate: 'gate1',
      provider,
      changedFiles: ['db/migrate/0001_init.sql'],
      hasPersistenceLayerFn: () => true,
    });
    assert.ok(
      selectedAudits.includes('audit-data-model'),
      `expected audit-data-model to be selected for a persistence-layer project; got ${selectedAudits.join(', ')}`,
    );
  });
});
