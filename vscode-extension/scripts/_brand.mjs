// Shared FreeAI brand renderer. The mark is the "F$" wordmark in JetBrains Mono
// (white) on a vertical coral gradient rounded square — the same monospace face
// as the site logo + favicon. A real webfont, so it's rasterized with headless
// Chromium (Playwright) rather than drawn procedurally; fonts are pulled from
// Google Fonts at render time (Inter is the lockup wordmark face).
//
// Used by gen-icon.mjs (marketplace icon) and gen-logos.mjs (full asset set).
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

// --- brand constants ---
// FreeAI palette — warm Claude-style orange (mirrors the site's theme.css).
export const GRAD_TOP = "#e08a6a";   // --accent-grad-a
export const GRAD_BOT = "#cf6b4a";   // --accent-grad-b
export const GREEN = "#d97757";      // --accent (name kept for render-API compat)
export const INK = "#1f1e1d";        // --ink
export const RADIUS_RATIO = 0.26;    // rounded-square corner radius (matches favicon / site logo)
export const FONT_RATIO = 0.47;      // F$ cap size vs icon size
// The "F$" mark is monospace — the same face as the site logo chip
// (.logo = var(--mono) = JetBrains Mono) and the favicon. FONT_STACK (sans,
// Inter) is the wordmark face, matching the site's .brand-name.
export const MARK_FONT =
  "'JetBrains Mono', 'DejaVu Sans Mono', ui-monospace, monospace";
export const FONT_STACK =
  "Inter, -apple-system, 'Segoe UI', Arial, sans-serif";

// Resolve playwright-core from one of the repo's e2e installs (no dedicated dep
// in extension/). Portable: paths are relative to the repo root.
export function loadChromium() {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const candidates = [
    "site/e2e",
    "test-stack/site-e2e",
    "test-stack/stripe-e2e",
    "test-stack",
  ].map((p) => join(root, p, "package.json"));
  for (const c of candidates) {
    try {
      return createRequire(c)("playwright-core").chromium;
    } catch {}
  }
  try {
    return createRequire(import.meta.url)("playwright-core").chromium;
  } catch {}
  throw new Error(
    "playwright-core not found. Install it (npm i -D playwright-core && npx playwright install chromium) " +
    "or run from a checkout that has site/e2e installed."
  );
}

const FONT_LINKS = `
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@700;800&family=JetBrains+Mono:wght@700&display=swap" rel="stylesheet">`;

function iconHTML(size) {
  const r = Math.round(size * RADIUS_RATIO);
  const fs = Math.round(size * FONT_RATIO);
  return `<!doctype html><html><head><meta charset="utf-8">${FONT_LINKS}
<style>html,body{margin:0;background:transparent}
#mark{width:${size}px;height:${size}px;border-radius:${r}px;
background:linear-gradient(180deg,${GRAD_TOP} 0%,${GRAD_BOT} 100%);
display:flex;align-items:center;justify-content:center;color:#fff;
font-family:${MARK_FONT};font-weight:700;font-size:${fs}px;line-height:1;
letter-spacing:0}</style></head>
<body><div id="mark">F$</div></body></html>`;
}

function lockupHTML(height) {
  const badge = Math.round(height * 0.92);
  const r = Math.round(badge * RADIUS_RATIO);
  const bfs = Math.round(badge * FONT_RATIO);
  const wfs = Math.round(height * 0.62);
  return `<!doctype html><html><head><meta charset="utf-8">${FONT_LINKS}
<style>html,body{margin:0;background:transparent}
#lk{display:inline-flex;align-items:center;gap:${Math.round(height * 0.22)}px;padding:${Math.round(height * 0.12)}px}
#b{width:${badge}px;height:${badge}px;border-radius:${r}px;flex:none;
background:linear-gradient(180deg,${GRAD_TOP} 0%,${GRAD_BOT} 100%);
display:flex;align-items:center;justify-content:center;color:#fff;
font-family:${MARK_FONT};font-weight:700;font-size:${bfs}px;line-height:1;letter-spacing:0}
#w{font-family:${FONT_STACK};font-weight:700;font-size:${wfs}px;color:${INK};
letter-spacing:-.02em;line-height:1}</style></head>
<body><div id="lk"><div id="b">F$</div><div id="w">FreeAI.fyi</div></div></body></html>`;
}

// Render a batch of icon sizes + an optional lockup with ONE browser launch.
// Returns { icons: Map<size, Buffer>, lockup?: Buffer }.
export async function renderAssets({ sizes = [], lockupHeight = 0 } = {}) {
  const chromium = loadChromium();
  const browser = await chromium.launch({ headless: true });
  const icons = new Map();
  let lockup;
  try {
    for (const size of sizes) {
      const page = await browser.newPage({
        viewport: { width: size + 40, height: size + 40 },
        deviceScaleFactor: 1,
      });
      await page.setContent(iconHTML(size), { waitUntil: "networkidle" });
      await page.evaluate(() => document.fonts.ready);
      const buf = await page.locator("#mark").screenshot({ omitBackground: true });
      icons.set(size, buf);
      await page.close();
    }
    if (lockupHeight) {
      const page = await browser.newPage({
        viewport: { width: 1200, height: lockupHeight * 3 },
        deviceScaleFactor: 2,
      });
      await page.setContent(lockupHTML(lockupHeight), { waitUntil: "networkidle" });
      await page.evaluate(() => document.fonts.ready);
      lockup = await page.locator("#lk").screenshot({ omitBackground: true });
      await page.close();
    }
  } finally {
    await browser.close();
  }
  return { icons, lockup };
}

// --- SVG variants (font-based; render true Montserrat where the font is
// available, fall back to a bold sans elsewhere) ---
export function markSVG({ box = true, fill = "#fff" } = {}) {
  const rect = box
    ? `\n  <defs><linearGradient id="kb" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${GRAD_TOP}"/><stop offset="1" stop-color="${GRAD_BOT}"/></linearGradient></defs>\n  <rect x="4" y="4" width="120" height="120" rx="28" fill="url(#kb)"/>`
    : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="128" height="128" role="img" aria-label="FreeAI.fyi">${rect}
  <text x="64" y="64" text-anchor="middle" dominant-baseline="central" font-family="${MARK_FONT}" font-weight="700" font-size="56" letter-spacing="0" fill="${fill}">F$</text>
</svg>`;
}

// --- ICO encoder (packs PNG buffers) ---
export function toICO(entries) {
  const count = entries.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(count, 4);
  let offset = 6 + count * 16;
  const dir = [];
  for (const { size, png } of entries) {
    const e = Buffer.alloc(16);
    e[0] = size >= 256 ? 0 : size;
    e[1] = size >= 256 ? 0 : size;
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(png.length, 8);
    e.writeUInt32LE(offset, 12);
    dir.push(e);
    offset += png.length;
  }
  return Buffer.concat([header, ...dir, ...entries.map((e) => e.png)]);
}
