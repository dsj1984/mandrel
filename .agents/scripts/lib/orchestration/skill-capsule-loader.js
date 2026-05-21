/**
 * skill-capsule-loader.js — Policy Capsule extraction for skill hydration.
 *
 * Resolves skills via `skills.index.json` and returns either the capsule
 * region or the full SKILL.md body (fallback / opt-in).
 *
 * @module lib/orchestration/skill-capsule-loader
 */

import fs from 'node:fs';
import path from 'node:path';

import { PROJECT_ROOT } from '../config-resolver.js';
import { Logger } from '../Logger.js';

const POLICY_HEADING_RE = /^## Policy Capsule\s*$/;
const ANY_H2_RE = /^## /;

/**
 * Split source on CRLF or LF without normalizing line endings.
 *
 * @param {string} src
 * @returns {string[]}
 */
function splitLines(src) {
  return src.split(/\r\n|\n/);
}

/**
 * Extract the Policy Capsule region from a SKILL.md body (heading through
 * the line before the next `## ` heading). Returns null when absent.
 *
 * @param {string} body
 * @returns {string | null}
 */
export function extractPolicyCapsuleSpan(body) {
  const lines = splitLines(body);
  let start = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (POLICY_HEADING_RE.test(lines[i])) {
      start = i;
      break;
    }
  }
  if (start === -1) return null;

  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (ANY_H2_RE.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join('\n');
}

/**
 * @param {object} skillsIndex
 * @param {string} skillName
 * @returns {object | null}
 */
function findSkillEntry(skillsIndex, skillName) {
  const skills = skillsIndex?.skills;
  if (!Array.isArray(skills)) return null;
  return skills.find((entry) => entry.name === skillName) ?? null;
}

/**
 * Load a skill's Policy Capsule (or full body on fallback / opt-in).
 *
 * @param {string} skillName
 * @param {{ skills: Array<{ name: string, path: string }> }} skillsIndex
 * @param {{
 *   fullBodyOptIn?: boolean,
 *   repoRoot?: string,
 *   readFile?: (absPath: string) => string,
 *   warn?: (message: string) => void,
 * }} [options]
 * @returns {{ capsule: string, source: 'capsule' | 'full-body-fallback' | 'full-body-optin' }}
 */
export function loadSkillCapsule(skillName, skillsIndex, options = {}) {
  const {
    fullBodyOptIn = false,
    repoRoot = PROJECT_ROOT,
    readFile = (absPath) => fs.readFileSync(absPath, 'utf8'),
    warn = (message) => Logger.warn(message),
  } = options;

  const entry = findSkillEntry(skillsIndex, skillName);
  if (!entry?.path) {
    throw new Error(
      `loadSkillCapsule: skill "${skillName}" not found in skills index`,
    );
  }

  const absPath = path.join(repoRoot, entry.path);
  const body = readFile(absPath);

  if (fullBodyOptIn) {
    return { capsule: body, source: 'full-body-optin' };
  }

  const span = extractPolicyCapsuleSpan(body);
  if (span) {
    return { capsule: span, source: 'capsule' };
  }

  warn(`capsule marker missing: ${skillName}`);
  return { capsule: body, source: 'full-body-fallback' };
}
