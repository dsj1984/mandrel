/**
 * tests/lib/npm-scripts.test.js — Story #4473.
 *
 * The shared `package.json` scripts probe used to decide whether a consumer
 * ships a given npm script before spawning `npm run <name>`.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  hasNpmScript,
  readPackageScripts,
} from '../../.agents/scripts/lib/npm-scripts.js';

describe('readPackageScripts', () => {
  let dir;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'npm-scripts-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns the scripts map when package.json has one', () => {
    writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ scripts: { test: 'node --test', lint: 'biome' } }),
    );
    assert.deepEqual(readPackageScripts(dir), {
      test: 'node --test',
      lint: 'biome',
    });
  });

  it('returns {} when package.json is absent', () => {
    assert.deepEqual(readPackageScripts(dir), {});
  });

  it('returns {} when package.json is unparseable', () => {
    writeFileSync(path.join(dir, 'package.json'), '{ not json');
    assert.deepEqual(readPackageScripts(dir), {});
  });

  it('returns {} when there is no scripts object', () => {
    writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'x' }),
    );
    assert.deepEqual(readPackageScripts(dir), {});
  });
});

describe('hasNpmScript', () => {
  it('is true for a present, non-empty script', () => {
    assert.equal(
      hasNpmScript({ 'test:coverage': 'c8 node --test' }, 'test:coverage'),
      true,
    );
  });

  it('is false for an absent, empty, or whitespace-only script', () => {
    assert.equal(hasNpmScript({}, 'test:coverage'), false);
    assert.equal(hasNpmScript({ 'test:coverage': '' }, 'test:coverage'), false);
    assert.equal(
      hasNpmScript({ 'test:coverage': '   ' }, 'test:coverage'),
      false,
    );
    assert.equal(hasNpmScript(undefined, 'test:coverage'), false);
  });
});
