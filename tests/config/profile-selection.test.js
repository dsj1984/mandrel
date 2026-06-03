/**
 * Profile selection in the bootstrap repo-config phase (Story #3527,
 * Feature #3517, Epic #3438).
 *
 * Exercises the seam that lets an installer pick a named config profile so
 * the repo-config phase seeds `.agentrc.json` from that profile's
 * posture-scoped delta rather than from the full bundled starter reference:
 *
 *   - `buildProfileAgentrcBody` — the pure seed-body builder: resolves +
 *     validates the profile delta, re-attaches `$schema`, applies the
 *     operator-identity placeholder + baseBranch substitution.
 *   - `ensureAgentrc` — the bootstrap step that branches on
 *     `answers.profile`: profile-seeded vs starter-seeded.
 *
 * Unit-tier: pure logic + a temp-dir filesystem fixture (the bootstrap step's
 * own I/O boundary). No network, no git, no real bootstrap run.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { ensureAgentrc } from '../../.agents/scripts/lib/bootstrap/project-bootstrap.js';
import { buildProfileAgentrcBody } from '../../.agents/scripts/lib/config/sync-agentrc.js';
import { getAgentrcValidator } from '../../.agents/scripts/lib/config-settings-schema.js';

const ANSWERS = Object.freeze({
  owner: 'acme',
  repo: 'widget',
  operatorHandle: 'me',
  baseBranch: 'main',
});

describe('buildProfileAgentrcBody — solo-local (minimal profile)', () => {
  it('produces a parseable JSON body scoped to the solo-local posture', () => {
    const body = buildProfileAgentrcBody({
      profile: 'solo-local',
      answers: ANSWERS,
    });
    const parsed = JSON.parse(body);
    // solo-local carries only `project` — no github / delivery blocks.
    assert.deepEqual(Object.keys(parsed).sort(), ['$schema', 'project']);
    assert.equal(parsed.github, undefined);
    assert.equal(parsed.delivery, undefined);
  });

  it('attaches the consumer-relative $schema pointer', () => {
    const body = buildProfileAgentrcBody({
      profile: 'solo-local',
      answers: ANSWERS,
    });
    const parsed = JSON.parse(body);
    assert.equal(parsed.$schema, './.agents/schemas/agentrc.schema.json');
  });

  it('validates against the runtime agentrc schema', () => {
    const body = buildProfileAgentrcBody({
      profile: 'solo-local',
      answers: ANSWERS,
    });
    const parsed = JSON.parse(body);
    // The editor `$schema` pointer is not a runtime config key — strip it
    // before validating, mirroring the resolver.
    delete parsed.$schema;
    const validate = getAgentrcValidator();
    assert.equal(
      validate(parsed),
      true,
      `solo-local seed failed validation: ${JSON.stringify(validate.errors)}`,
    );
  });

  it('terminates the body with a trailing newline', () => {
    const body = buildProfileAgentrcBody({
      profile: 'solo-local',
      answers: ANSWERS,
    });
    assert.ok(body.endsWith('\n'));
  });
});

describe('buildProfileAgentrcBody — placeholder + baseBranch substitution', () => {
  it('substitutes operator identity into a github-bearing profile', () => {
    const body = buildProfileAgentrcBody({
      profile: 'team-github',
      answers: ANSWERS,
    });
    const parsed = JSON.parse(body);
    assert.equal(parsed.github.owner, 'acme');
    assert.equal(parsed.github.repo, 'widget');
    assert.equal(parsed.github.operatorHandle, '@me');
    assert.ok(!body.includes('[OWNER]'));
    assert.ok(!body.includes('[REPO]'));
    assert.ok(!body.includes('[USERNAME]'));
  });

  it('falls back to owner when operatorHandle is absent', () => {
    const body = buildProfileAgentrcBody({
      profile: 'team-github',
      answers: { owner: 'acme', repo: 'widget', baseBranch: 'main' },
    });
    const parsed = JSON.parse(body);
    assert.equal(parsed.github.operatorHandle, '@acme');
  });

  it('overrides the pinned baseBranch when the operator chose another', () => {
    const body = buildProfileAgentrcBody({
      profile: 'solo-local',
      answers: { ...ANSWERS, baseBranch: 'trunk' },
    });
    const parsed = JSON.parse(body);
    assert.equal(parsed.project.baseBranch, 'trunk');
  });

  it('leaves baseBranch at main when the operator kept the default', () => {
    const body = buildProfileAgentrcBody({
      profile: 'solo-local',
      answers: ANSWERS,
    });
    const parsed = JSON.parse(body);
    assert.equal(parsed.project.baseBranch, 'main');
  });
});

describe('buildProfileAgentrcBody — unknown profile', () => {
  it('throws for a profile name that is not registered', () => {
    assert.throws(
      () => buildProfileAgentrcBody({ profile: 'nope', answers: ANSWERS }),
      /Unknown config profile/,
    );
  });
});

describe('ensureAgentrc — profile vs starter seeding', () => {
  let tmpRoot;
  let agentRoot;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'profile-selection-'));
    // Seed a fake starter so the no-profile path is exercised against a
    // known full reference rather than the live bundled file.
    agentRoot = path.join(tmpRoot, '.agents');
    fs.mkdirSync(agentRoot, { recursive: true });
    fs.writeFileSync(
      path.join(agentRoot, 'starter-agentrc.json'),
      JSON.stringify({
        project: { baseBranch: 'main' },
        github: {
          owner: '[OWNER]',
          repo: '[REPO]',
          operatorHandle: '@[USERNAME]',
        },
        delivery: { ci: { skipForStoryPushes: true } },
      }),
    );
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('seeds a minimal .agentrc.json scoped to the chosen solo-local profile', () => {
    const outcome = ensureAgentrc({
      projectRoot: tmpRoot,
      agentRoot,
      answers: { ...ANSWERS, profile: 'solo-local' },
    });
    assert.equal(outcome.action, 'seeded');
    assert.equal(outcome.source, 'profile');
    assert.equal(outcome.profile, 'solo-local');
    const seeded = JSON.parse(
      fs.readFileSync(path.join(tmpRoot, '.agentrc.json'), 'utf8'),
    );
    // The minimal profile seed scopes the config to `project` only — it does
    // NOT inherit the starter's github / delivery blocks.
    assert.deepEqual(Object.keys(seeded).sort(), ['$schema', 'project']);
    assert.equal(seeded.github, undefined);
    assert.equal(seeded.delivery, undefined);
  });

  it('seeds from the chosen profile delta rather than the full starter reference', () => {
    ensureAgentrc({
      projectRoot: tmpRoot,
      agentRoot,
      answers: { ...ANSWERS, profile: 'solo-local' },
    });
    const seeded = JSON.parse(
      fs.readFileSync(path.join(tmpRoot, '.agentrc.json'), 'utf8'),
    );
    const starter = JSON.parse(
      fs.readFileSync(path.join(agentRoot, 'starter-agentrc.json'), 'utf8'),
    );
    // The seeded config must NOT be the full starter reference: the starter
    // carries github + delivery blocks the solo-local profile deliberately
    // omits.
    assert.ok(starter.github, 'fixture starter should carry a github block');
    assert.equal(
      seeded.github,
      undefined,
      'profile-seeded config must not inherit the starter github block',
    );
  });

  it('seeds from the bundled starter when no profile is chosen', () => {
    const outcome = ensureAgentrc({
      projectRoot: tmpRoot,
      agentRoot,
      answers: { ...ANSWERS },
    });
    assert.equal(outcome.action, 'seeded');
    assert.equal(outcome.source, 'starter');
    const seeded = JSON.parse(
      fs.readFileSync(path.join(tmpRoot, '.agentrc.json'), 'utf8'),
    );
    // Starter path keeps the full reference shape (github block present,
    // placeholders substituted).
    assert.equal(seeded.github.owner, 'acme');
    assert.equal(seeded.delivery.ci.skipForStoryPushes, true);
  });

  it('treats a blank profile string as no profile (starter path)', () => {
    const outcome = ensureAgentrc({
      projectRoot: tmpRoot,
      agentRoot,
      answers: { ...ANSWERS, profile: '' },
    });
    assert.equal(outcome.source, 'starter');
  });

  it('never overwrites an existing .agentrc.json even when a profile is chosen', () => {
    fs.writeFileSync(
      path.join(tmpRoot, '.agentrc.json'),
      '{"project":{"baseBranch":"keep"}}',
    );
    const outcome = ensureAgentrc({
      projectRoot: tmpRoot,
      agentRoot,
      answers: { ...ANSWERS, profile: 'solo-local' },
    });
    assert.equal(outcome.action, 'already-present');
    const kept = JSON.parse(
      fs.readFileSync(path.join(tmpRoot, '.agentrc.json'), 'utf8'),
    );
    assert.equal(kept.project.baseBranch, 'keep');
  });
});
