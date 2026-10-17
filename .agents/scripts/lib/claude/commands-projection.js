/**
 * Claude command projection: `.agents/workflows/` and `.agents/local/workflows/`
 * become a flat `.claude/commands/` tree (flat, not a plugin tree, which some
 * hosts lack). Payload wins a collision; `loops/` is the one recursed
 * subdirectory. Node built-ins only, so the doctor can import it.
 */

import fs from 'node:fs';
import path from 'node:path';

import { applyHeader, isCommandExcluded } from '../command-header.js';
import { dirExists } from '../util/paths.js';

export const CLAUDE_COMMANDS_DIR = '.claude/commands';

const HEADER =
  '<!-- AUTO-GENERATED — do not edit. Source of truth: .agents/workflows/ -->\n<!-- Re-run: npm run sync:commands -->\n\n';

const LOCAL_HEADER =
  '<!-- AUTO-GENERATED from .agents/local/ — do not edit. Source of truth: .agents/local/workflows/ -->\n<!-- Re-run: npm run sync:commands -->\n\n';

const LOOPS_NS = 'loops';

/**
 * @param {string} dir
 * @param {boolean} skipReadme
 * @returns {string[]}
 */
function mdFilesIn(dir, skipReadme) {
  if (!dirExists(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter(
      (e) =>
        e.isFile() &&
        e.name.endsWith('.md') &&
        !(skipReadme && e.name.toLowerCase() === 'readme.md'),
    )
    .map((e) => e.name);
}

/**
 * Flat commands, then `loops/<name>.md`.
 *
 * @param {string} dir
 * @returns {string[]}
 */
function commandRelsIn(dir) {
  return [
    ...mdFilesIn(dir, false),
    ...mdFilesIn(path.join(dir, LOOPS_NS), true).map((f) => `${LOOPS_NS}/${f}`),
  ];
}

/**
 * Projected bytes keyed by destination-relative path. A `command: false` copy
 * never claims its name.
 *
 * @param {{
 *   projectRoot: string,
 *   payloadSrc?: string,
 *   localSrc?: string,
 *   warn?: (line: string) => void,
 * }} opts
 * @returns {Map<string, string>}
 */
export function expectedClaudeCommands({
  projectRoot,
  payloadSrc = path.join(projectRoot, '.agents', 'workflows'),
  localSrc = path.join(projectRoot, '.agents', 'local', 'workflows'),
  warn = () => {},
}) {
  const expected = new Map();
  for (const [dir, header] of [
    [payloadSrc, HEADER],
    [localSrc, LOCAL_HEADER],
  ]) {
    for (const rel of commandRelsIn(dir)) {
      if (expected.has(rel)) {
        warn(`  shadowed  ${rel} (local copy ignored; payload wins)`);
        continue;
      }
      const content = fs.readFileSync(path.join(dir, rel), 'utf8');
      if (isCommandExcluded(content)) {
        warn(`  excluded ${rel} (frontmatter command: false)`);
        continue;
      }
      expected.set(rel, applyHeader(content, header));
    }
  }
  return expected;
}

/**
 * @param {string} destDir
 * @returns {string[]}
 */
export function listGeneratedClaudeCommands(destDir) {
  return commandRelsIn(destDir)
    .filter((rel) => !path.basename(rel).startsWith('.'))
    .sort();
}

/**
 * Remove a plugin projection, which would shadow the flat commands.
 *
 * @param {string} projectRoot
 * @param {(line: string) => void} warn
 * @returns {void}
 */
function reapPluginTree(projectRoot, warn) {
  const claudeDir = path.join(projectRoot, '.claude');
  for (const target of [
    path.join(claudeDir, 'plugins', 'mandrel'),
    path.join(claudeDir, '.claude-plugin', 'marketplace.json'),
  ]) {
    try {
      fs.rmSync(target, { recursive: true, force: true });
    } catch (err) {
      warn(`  skip reap ${target}: ${err.message}`);
    }
  }
  try {
    fs.rmdirSync(path.join(claudeDir, '.claude-plugin'));
  } catch {
    /* not empty or absent — leave it */
  }
}

/**
 * Write the projection, reap orphans, skip unchanged files.
 *
 * @param {{
 *   projectRoot: string,
 *   payloadSrc?: string,
 *   localSrc?: string,
 *   destDir?: string,
 *   log?: (line: string) => void,
 *   warn?: (line: string) => void,
 * }} opts
 * @returns {{ written: string[], removed: string[], total: number }}
 */
export function syncClaudeCommands({
  projectRoot,
  payloadSrc,
  localSrc,
  destDir = path.join(projectRoot, ...CLAUDE_COMMANDS_DIR.split('/')),
  log = () => {},
  warn = log,
}) {
  reapPluginTree(projectRoot, warn);
  fs.mkdirSync(destDir, { recursive: true });
  const expected = expectedClaudeCommands({
    projectRoot,
    payloadSrc,
    localSrc,
    warn,
  });

  const removed = [];
  for (const rel of commandRelsIn(destDir)) {
    if (expected.has(rel)) continue;
    fs.unlinkSync(path.join(destDir, rel));
    removed.push(rel);
    log(`  removed  ${rel} (no longer in workflows)`);
  }

  const written = [];
  for (const [rel, body] of expected) {
    const dest = path.join(destDir, rel);
    let current = null;
    try {
      current = fs.readFileSync(dest, 'utf8');
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    if (current === body) continue;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, body, 'utf8');
    written.push(rel);
    log(`  synced   ${rel}`);
  }
  return { written, removed, total: expected.size };
}
