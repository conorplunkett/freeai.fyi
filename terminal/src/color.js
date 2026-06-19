// Terminal color helpers for the FreeAI ad line.
//
// The status line is a single row of text, so the only styling surface we have
// is ANSI SGR. We render the advertiser's chosen color as 24-bit truecolor and,
// when no color is set, derive a stable, pleasant color from the brand name so
// the line still looks intentional. A "shimmer" sweeps a lightened band across
// the text on each status-line refresh to read as live, like Claude's spinner.

const ESC = "\u001b";
const RESET = `${ESC}[0m`;

// Accept "#rrggbb" or "rrggbb"; return canonical "#rrggbb" or "" when invalid.
export function normalizeHex(value) {
  const match = /^#?([0-9a-f]{6})$/i.exec(String(value ?? "").trim());
  return match ? `#${match[1].toLowerCase()}` : "";
}

export function hexToRgb(value) {
  const hex = normalizeHex(value);
  if (!hex) return null;
  const n = parseInt(hex.slice(1), 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

export function ansiFg({ r, g, b }) {
  return `${ESC}[38;2;${r};${g};${b}m`;
}

// Mix a color toward white by t in [0,1] — used for the shimmer highlight.
export function lighten({ r, g, b }, t) {
  const clamp = Math.max(0, Math.min(1, t));
  const mix = (c) => Math.round(c + (255 - c) * clamp);
  return { r: mix(r), g: mix(g), b: mix(b) };
}

function hslToRgb(h, s, l) {
  const sat = s / 100;
  const lum = l / 100;
  const c = (1 - Math.abs(2 * lum - 1)) * sat;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = lum - c / 2;
  let r = 0, g = 0, b = 0;
  if (h < 60) { r = c; g = x; }
  else if (h < 120) { r = x; g = c; }
  else if (h < 180) { g = c; b = x; }
  else if (h < 240) { g = x; b = c; }
  else if (h < 300) { r = x; b = c; }
  else { r = c; b = x; }
  return {
    r: Math.round((r + m) * 255),
    g: Math.round((g + m) * 255),
    b: Math.round((b + m) * 255),
  };
}

// Deterministic, readable color from any seed string (brand or line). Stable
// hue per advertiser, fixed saturation/lightness so it always reads on a dark
// terminal. This is only the fallback when the advertiser sets no color.
export function brandColor(seed) {
  const str = String(seed || "freeai");
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash * 31 + str.charCodeAt(i)) >>> 0;
  }
  return hslToRgb(hash % 360, 62, 64);
}

// Resolve the rgb the ad line should use: advertiser color when valid,
// otherwise the per-brand fallback.
export function resolveAdColor({ color, seed } = {}) {
  return hexToRgb(color) || brandColor(seed);
}

// Style `text` with bold + underline in `rgb`, sweeping a lightened shimmer
// band across it. `now`/`cycleMs` drive the sweep position so it advances on
// each refresh; `width` is the band size in characters.
export function shimmer(text, rgb, { now = Date.now(), cycleMs = 4000, width = 6 } = {}) {
  const chars = Array.from(text);
  const n = chars.length;
  if (n === 0) return "";
  const base = ansiFg(rgb);
  const glow = ansiFg(lighten(rgb, 0.55));
  const span = n + width;
  const head = Math.floor((now / cycleMs) * span) % span;
  let out = `${ESC}[1m${ESC}[4m${base}`;
  let lit = false;
  for (let i = 0; i < n; i++) {
    const inBand = i <= head && i > head - width;
    if (inBand && !lit) { out += glow; lit = true; }
    else if (!inBand && lit) { out += base; lit = false; }
    out += chars[i];
  }
  return out + RESET;
}

// Wrap text in an OSC 8 hyperlink so the whole line is clickable.
export function hyperlink(url, text) {
  return `${ESC}]8;;${url}${ESC}\\${text}${ESC}]8;;${ESC}\\`;
}

// Dim, non-styled "ad·" prefix that labels the line as sponsored.
export function dimLabel(text) {
  return `${ESC}[2m${text}${RESET}`;
}
