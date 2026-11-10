/**
 * Message envelope rendering.
 *
 * The header is its own markdown block, so the body must start on a new block:
 * header and body are joined with exactly two newlines. That keeps a body that
 * starts with a list, quote, heading or fenced code block rendering correctly
 * instead of being absorbed into the bold header paragraph.
 */

export function formatTimestamp(ms) {
  const d = new Date(ms);
  const pad = (value, width = 2) => String(value).padStart(width, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} `
    + `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.`
    + `${pad(d.getMilliseconds(), 3)}`;
}

export function sanitizeKey(key) {
  if (typeof key !== 'string') return null;
  const cleaned = key.replace(/[\r\n]+/g, ' ').trim();
  return cleaned ? cleaned.slice(0, 64) : null;
}

export function renderMessage({ body, key = null, receivedAt }) {
  if (typeof body !== 'string' || body === '') {
    throw new TypeError('body must be a non-empty string');
  }
  const ts = formatTimestamp(receivedAt);
  const cleanKey = sanitizeKey(key);
  const markdownHead = cleanKey ? `**[${ts}] #${cleanKey}**` : `**[${ts}]**`;
  const plainHead = cleanKey ? `[${ts}] #${cleanKey}` : `[${ts}]`;
  return {
    markdown: `${markdownHead}\n\n${body}`,
    plain: `${plainHead}\n\n${body}`
  };
}
