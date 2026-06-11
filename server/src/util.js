// Small shared helpers.

// Escape text for safe interpolation into HTML. Ad lines are advertiser-supplied
// and rendered on the site, the admin page, and the extension webview — so every
// one of those render paths must run untrusted text through this.
function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"'/]/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
    "/": "&#47;",
  }[ch]));
}

// Ad-line intake validation (defense in depth on top of render-time escaping):
// printable text, no angle brackets, no control chars, 3–60 chars.
function isCleanAdLine(s) {
  if (typeof s !== "string") return false;
  if (s.length < 3 || s.length > 60) return false;
  if (s.includes("<") || s.includes(">")) return false;
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return false; // reject control characters
  }
  return true;
}

module.exports = { escapeHtml, isCleanAdLine };
