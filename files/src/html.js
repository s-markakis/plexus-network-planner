// Markup helpers shared by app.js and the modules that build HTML.

/** Escape text for HTML element content and quoted attribute values. */
export function esc(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

/** A colour from a project file, for use inside markup: hex only, else ''. */
export function safeColor(c) { return typeof c === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(c) ? c : ''; }
