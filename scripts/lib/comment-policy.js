/**
 * comment-policy.js — the scanner and rules behind `check-comment-policy.js`.
 *
 * The policy (docs/contributing/comment-policy.md): a comment states what the
 * code cannot — a contract, an invariant, a non-obvious reason — once, at the
 * narrowest scope that owns it, and never narrates history. Two ratchets hold
 * it: comment bytes may not exceed {@link COMMENT_RATIO_CEILING} of the
 * payload's script bytes, and no comment may cite a ticket, pull request or
 * decision-record number.
 *
 * The scanner is hand-rolled and dependency-free. It understands string,
 * template (including nested `${}` expressions) and regular-expression
 * literals, so a `//` inside a URL or a `/*` inside a regex is never mistaken
 * for a comment. Regex-versus-division is decided by the previous significant
 * token, the same heuristic every JavaScript highlighter uses.
 */

/**
 * The landed ceiling on comment bytes as a fraction of script bytes. It may
 * only be lowered.
 */
export const COMMENT_RATIO_CEILING = 0.35;

/** Directories whose comments the provenance lint reads. */
export const PROVENANCE_ROOTS = ['.agents/scripts', 'bin', 'lib'];

/** The directory whose comment ratio the ceiling bounds. */
export const RATIO_ROOT = '.agents/scripts';

/**
 * A comment citing a ticket, pull request or decision record: `Story #N`,
 * `PR #N`, `Epic #N`, `ADR <date-id>`, or a bare `#NN…` issue reference.
 */
export const PROVENANCE_PATTERN =
  /\b(?:Story|Stories|PR|PRs|Epic|Epics|Issue|Issues)\s*#\d+|\bADR[ -]?\d{6,}|(?<![\w&/#])#\d{2,}\b/;

/** JSDoc tags that form the type surface and must survive a trim. */
export const TYPE_TAGS = ['param', 'returns', 'typedef', 'throws'];

const KEYWORDS_BEFORE_EXPRESSION = new Set([
  'return',
  'typeof',
  'instanceof',
  'in',
  'of',
  'new',
  'delete',
  'void',
  'throw',
  'case',
  'do',
  'else',
  'yield',
  'await',
]);

/**
 * True when a script file belongs to the scanned surface: JavaScript, not a
 * test, not generated.
 *
 * @param {string} file repo-relative path with forward slashes
 * @returns {boolean}
 */
export function isScannedSource(file) {
  return (
    /\.[cm]?js$/.test(file) &&
    !/(^|\/)__tests__\//.test(file) &&
    !/\.test\.[cm]?js$/.test(file) &&
    !/(^|\/)lib\/generated\//.test(file)
  );
}

/**
 * Whether a `/` at the current position opens a regex literal, judged from the
 * code emitted so far.
 *
 * @param {string} code code-only text preceding the slash
 * @returns {boolean}
 */
function slashOpensRegex(code) {
  const trimmed = code.trimEnd();
  if (trimmed === '') return true;
  const last = trimmed[trimmed.length - 1];
  if (/[\w$]/.test(last)) {
    const word = /[\w$]+$/.exec(trimmed)[0];
    return KEYWORDS_BEFORE_EXPRESSION.has(word);
  }
  return !/[)\].'"`]/.test(last);
}

/**
 * Index just past a quoted string opening at `start`.
 *
 * @param {string} s
 * @param {number} start
 * @returns {number}
 */
function endOfString(s, start) {
  const quote = s[start];
  let i = start + 1;
  while (i < s.length) {
    if (s[i] === '\\') i += 2;
    else if (s[i] === quote || s[i] === '\n') return i + 1;
    else i += 1;
  }
  return s.length;
}

/**
 * Index just past a regex literal opening at `start`.
 *
 * @param {string} s
 * @param {number} start
 * @returns {number}
 */
function endOfRegex(s, start) {
  let i = start + 1;
  let inClass = false;
  while (i < s.length) {
    const ch = s[i];
    if (ch === '\\') i += 2;
    else if (ch === '\n') return i;
    else {
      if (ch === '[') inClass = true;
      else if (ch === ']') inClass = false;
      else if (ch === '/' && !inClass) {
        i += 1;
        while (i < s.length && /[a-z]/i.test(s[i])) i += 1;
        return i;
      }
      i += 1;
    }
  }
  return s.length;
}

/**
 * Split JavaScript source into code and comment segments. Literals are code.
 *
 * @param {string} source
 * @returns {Array<{ kind: 'code' | 'comment' | 'literal', text: string }>}
 */
export function tokenizeComments(source) {
  const s = String(source ?? '');
  /** @type {Array<{ kind: 'code' | 'comment' | 'literal', text: string }>} */
  const parts = [];
  let code = '';
  let codeSoFar = '';
  // Only the tail matters to the regex-versus-division decision.
  const remember = (text) => {
    codeSoFar = (codeSoFar + text).slice(-64);
  };
  const pushCode = (text) => {
    code += text;
    remember(text);
  };
  const flushCode = () => {
    if (code) parts.push({ kind: 'code', text: code });
    code = '';
  };
  const pushOther = (kind, text) => {
    flushCode();
    parts.push({ kind, text });
    if (kind === 'literal') remember(text);
  };
  // Each entry is the brace depth at which a template `${` expression opened.
  const templateStack = [];
  let braceDepth = 0;
  let i = 0;

  /**
   * Scan template text from `start` (just past a backtick or a closing `}`)
   * until the closing backtick or the next `${`.
   *
   * @param {number} start
   * @returns {number}
   */
  const scanTemplate = (start) => {
    let j = start;
    while (j < s.length) {
      if (s[j] === '\\') j += 2;
      else if (s[j] === '`') return j + 1;
      else if (s[j] === '$' && s[j + 1] === '{') {
        templateStack.push(braceDepth);
        braceDepth += 1;
        return j + 2;
      } else j += 1;
    }
    return s.length;
  };

  while (i < s.length) {
    const ch = s[i];
    const next = s[i + 1];
    if (ch === '/' && next === '/') {
      const nl = s.indexOf('\n', i);
      const end = nl === -1 ? s.length : nl;
      pushOther('comment', s.slice(i, end));
      i = end;
    } else if (ch === '/' && next === '*') {
      const close = s.indexOf('*/', i + 2);
      const end = close === -1 ? s.length : close + 2;
      pushOther('comment', s.slice(i, end));
      i = end;
    } else if (ch === '/' && slashOpensRegex(codeSoFar)) {
      const end = endOfRegex(s, i);
      pushOther('literal', s.slice(i, end));
      i = end;
    } else if (ch === "'" || ch === '"') {
      const end = endOfString(s, i);
      pushOther('literal', s.slice(i, end));
      i = end;
    } else if (ch === '`') {
      const end = scanTemplate(i + 1);
      pushOther('literal', s.slice(i, end));
      i = end;
    } else if (ch === '{') {
      braceDepth += 1;
      pushCode(ch);
      i += 1;
    } else if (ch === '}') {
      braceDepth -= 1;
      if (
        templateStack.length > 0 &&
        templateStack[templateStack.length - 1] === braceDepth
      ) {
        templateStack.pop();
        const end = scanTemplate(i + 1);
        pushOther('literal', s.slice(i, end));
        i = end;
      } else {
        pushCode(ch);
        i += 1;
      }
    } else {
      pushCode(ch);
      i += 1;
    }
  }
  flushCode();
  return parts;
}

/**
 * The comments in `source`, in order.
 *
 * @param {string} source
 * @returns {string[]}
 */
export function extractComments(source) {
  return tokenizeComments(source)
    .filter((p) => p.kind === 'comment')
    .map((p) => p.text);
}

/**
 * Comment-free, formatting-free code text: comments removed, whitespace
 * outside literals dropped except where it separates two word characters,
 * and trailing commas dropped — so deleting a comment, and the reflow a
 * formatter applies afterwards, leave the result unchanged. Directive
 * comments (`biome-ignore`, `eslint-`, `@ts-`, `node:coverage`, `c8`,
 * `istanbul`) are kept, because deleting one changes tool behaviour.
 *
 * @param {string} source
 * @returns {string}
 */
export function normalizedCode(source) {
  /** @type {Array<{ literal: boolean, text: string }>} */
  const pieces = [];
  const add = (literal, text) => {
    const last = pieces[pieces.length - 1];
    if (!literal && last && !last.literal) last.text += text;
    else pieces.push({ literal, text });
  };
  for (const part of tokenizeComments(source)) {
    if (part.kind === 'literal') add(true, part.text);
    else if (part.kind === 'code') add(false, part.text);
    else if (isDirectiveComment(part.text)) add(true, part.text.trim());
    else add(false, ' ');
  }
  return pieces
    .map((p) => (p.literal ? p.text : squeeze(p.text)))
    .join('\u0001');
}

/**
 * True for a comment a tool reads: a lint or coverage directive, a type
 * directive, or a license header.
 *
 * @param {string} comment
 * @returns {boolean}
 */
export function isDirectiveComment(comment) {
  return /^\/[/*]\s*(?:biome-ignore|eslint-|@ts-|node:coverage|c8 |istanbul |cli-opt-out|@license|@preserve)/.test(
    comment,
  );
}

/**
 * Collapse whitespace in a code run: drop it except between two word
 * characters, and drop trailing commas, so a formatter's reflow after a
 * comment deletion leaves the result unchanged.
 *
 * @param {string} code
 * @returns {string}
 */
function squeeze(code) {
  return code
    .replace(/\s+/g, ' ')
    .replace(/([^\w$]) | (?=[^\w$])/g, '$1')
    .replace(/,([)\]}])/g, '$1')
    .trim();
}

/**
 * Comment and total byte counts for one source.
 *
 * @param {string} source
 * @returns {{ total: number, comment: number }}
 */
export function commentBytes(source) {
  const comments = extractComments(source);
  return {
    total: Buffer.byteLength(source),
    comment: comments.reduce((n, c) => n + Buffer.byteLength(c), 0),
  };
}

/**
 * Provenance citations in `source`'s comments.
 *
 * @param {string} source
 * @returns {Array<{ line: number, match: string }>}
 */
export function findProvenance(source) {
  const hits = [];
  let offset = 0;
  for (const part of tokenizeComments(source)) {
    if (part.kind === 'comment') {
      const lines = part.text.split('\n');
      lines.forEach((text, k) => {
        const m = PROVENANCE_PATTERN.exec(text);
        if (m) {
          const line = source.slice(0, offset).split('\n').length + k;
          hits.push({ line, match: m[0] });
        }
      });
    }
    offset += part.text.length;
  }
  return hits;
}

/**
 * The JSDoc type-surface tags in `source`, as a sorted multiset of
 * `@tag name` keys (the name only for `@param` and `@typedef`).
 *
 * @param {string} source
 * @returns {string[]}
 */
export function typeTags(source) {
  const keys = [];
  const tagRe = new RegExp(
    `@(${TYPE_TAGS.join('|')})\\b\\s*(?:\\{[^}]*\\}\\s*)?(\\[?[\\w$.]+)?`,
    'g',
  );
  for (const comment of extractComments(source)) {
    if (!comment.startsWith('/**')) continue;
    for (const m of comment.matchAll(tagRe)) {
      const named = m[1] === 'param' || m[1] === 'typedef';
      keys.push(named ? `@${m[1]} ${m[2] ?? ''}` : `@${m[1]}`);
    }
  }
  return keys.sort();
}
