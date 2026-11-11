/**
 * Message envelope rendering.
 *
 * The header is its own markdown block, so the body must start on a new block:
 * header and body are joined with exactly two newlines. That keeps a body that
 * starts with a list, quote, heading or fenced code block rendering correctly
 * instead of being absorbed into the bold header paragraph.
 */

export const KEY_MAX_BYTES = 32;

// Spaces and control whitespace at the edges only; interior characters are kept.
const EDGE_TRIM = /^[\s\u0008]+|[\s\u0008]+$/gu;
// Printable characters only: no control/format/surrogate code points, no line
// or paragraph separators, and no backtick (it would close the code span).
const FORBIDDEN = /[\p{C}\p{Zl}\p{Zp}`]/u;

export class InvalidKeyError extends Error {
  constructor(reason) {
    super(reason);
    this.name = 'InvalidKeyError';
    this.reason = reason;
  }
}

export function formatTimestamp(ms) {
  const d = new Date(ms);
  const pad = (value, width = 2) => String(value).padStart(width, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} `
    + `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.`
    + `${pad(d.getMilliseconds(), 3)}`;
}

/** Remove edge whitespace (including Unicode spaces) and backspace; keep the middle. */
export function trimKey(key) {
  return key.replace(EDGE_TRIM, '');
}

/**
 * Validate and normalize a caller-supplied key.
 * Returns null when the key is absent; throws InvalidKeyError when present but invalid.
 */
export function normalizeKey(key) {
  if (key === null || key === undefined) return null;
  if (typeof key !== 'string') throw new InvalidKeyError('key must be a string');
  const trimmed = trimKey(key);
  if (trimmed === '') throw new InvalidKeyError('key must not be empty');
  if (Buffer.byteLength(trimmed, 'utf8') > KEY_MAX_BYTES) {
    throw new InvalidKeyError(`key exceeds ${KEY_MAX_BYTES} bytes after trimming`);
  }
  if (FORBIDDEN.test(trimmed)) {
    throw new InvalidKeyError('key contains a control character or a backtick');
  }
  return trimmed;
}

/**
 * Render the markdown and plain-text envelopes.
 * The key is expected to be already normalized (see normalizeKey).
 */
export function renderMessage({ body, key = null, receivedAt }) {
  if (typeof body !== 'string' || body === '') {
    throw new TypeError('body must be a non-empty string');
  }
  const ts = formatTimestamp(receivedAt);
  const markdownHead = key ? `**[${ts}]** \`${key}\`` : `**[${ts}]**`;
  const plainHead = key ? `[${ts}] ${key}` : `[${ts}]`;
  return {
    markdown: `${markdownHead}\n\n${body}`,
    plain: `${plainHead}\n\n${body}`
  };
}
