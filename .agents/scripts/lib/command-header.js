/** Helpers for projecting workflow `.md` files into slash commands. */

/**
 * Insert `header` after any YAML frontmatter: Claude Code only parses
 * frontmatter that starts on line 1.
 *
 * @param {string} content - Raw workflow `.md` content.
 * @param {string} header - Provenance header to inject (typically ends `\n\n`).
 * @returns {string}
 */
export function applyHeader(content, header) {
  const frontmatter = content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n/);
  if (!frontmatter) return header + content;
  const block = frontmatter[0];
  const body = content.slice(block.length).replace(/^\r?\n/, '');
  return `${block}\n${header}${body}`;
}

/**
 * `command: false` in frontmatter opts a workflow out of slash-command
 * projection (e.g. a lens the host ships natively). The sync and the doctor
 * parity check both honour it.
 *
 * @param {string} content - Raw workflow `.md` content.
 * @returns {boolean}
 */
export function isCommandExcluded(content) {
  const frontmatter = String(content).match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!frontmatter) return false;
  return /^command:\s*false\s*$/m.test(frontmatter[1]);
}
