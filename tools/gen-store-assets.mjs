// Generate the Chrome Web Store listing assets — everything that goes in the
// developer dashboard, at the exact pixel sizes Google requires.
//
// Like tools/gen-og.mjs this drives the repo's Playwright Chromium (real font
// rendering) and reads the palette straight from theme.css so the marketing
// tiles can never drift from the product's colors (AGENTS.md ▸ Design system —
// never hardcode a color). It captures the LIVE site (served from a throwaway
// static server) so the screenshots show the real extension, not a mockup, then
// hands every output to tools/png_fit.py which pads/flattens to the exact size
// as a 24-bit PNG with NO alpha — the format the dashboard's "image size is
// incorrect" check demands for screenshots and promo tiles.
//
// Writes (overwrites) into store-assets/:
//   store-icon-128x128.png               128×128   Store icon            (alpha ok)
//   screenshot-chatgpt-1280x800.png      1280×800  Screenshots (ChatGPT chat)
//   screenshot-claude-1280x800.png       1280×800  Screenshots (Claude chat)
//   screenshot-gemini-1280x800.png       1280×800  Screenshots (Gemini chat)
//   screenshot-hero-1280x800.png         1280×800  Screenshots (homepage hero)
//   screenshot-install-1280x800.png      1280×800  Screenshots (install / CTA)
//   screenshot-popup-credits-640x400.png 640×400   Screenshots (popup — credits/crew)
//   screenshot-popup-market-640x400.png  640×400   Screenshots (popup — bid market)
//   marquee-1400x560.png                 1400×560  Marquee promo tile
//   promo-small-440x280.png              440×280   Small promo tile
//
// Chrome allows at most 5 screenshots per listing — pick your 5 from the seven
// screenshot-* files above (sizes may be mixed: 1280×800 and/or 640×400).
//
// Run:  make store-assets   (or:  node tools/gen-store-assets.mjs)

import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join, extname } from "node:path";
import { tmpdir } from "node:os";
import http from "node:http";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "store-assets");
const PNG_FIT = join(ROOT, "tools", "png_fit.py");
const ICON_SRC = join(ROOT, "desktop/macos/SponsorOverlay/packaging/assets/AppIcon-1024.png");

const require = createRequire(import.meta.url);
let chromium;
for (const spec of ["playwright", "/opt/node22/lib/node_modules/playwright", "playwright-core"]) {
  try { ({ chromium } = require(spec)); break; } catch { /* next */ }
}
if (!chromium) { console.error("gen-store-assets: Playwright not found (npm i -g playwright)."); process.exit(1); }

// ── palette from theme.css :root (resolve one var() alias level) ─────────────
const themeCss = readFileSync(join(ROOT, "web", "theme.css"), "utf8");
const rootBlock = themeCss.slice(themeCss.indexOf(":root"));
const raw = {};
for (const m of rootBlock.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) raw[m[1]] = m[2].trim();
const tok = (n) => {
  let v = raw[n]; const ref = v && v.match(/^var\((--[\w-]+)\)$/);
  if (ref) v = raw[ref[1]];
  if (v == null) throw new Error(`gen-store-assets: token ${n} missing in theme.css`);
  return v.trim();
};
const C = {
  accent: tok("--accent"), accentD: tok("--accent-d"),
  gradA: tok("--accent-grad-a"), gradB: tok("--accent-grad-b"), rgb: tok("--accent-rgb"),
  cream: tok("--bg-cream"), tint: tok("--bg-tint"),
  ink: tok("--ink"), ink2: tok("--ink-2"), gray: tok("--gray"), line: tok("--line"),
  ovBg: tok("--ov-bar-bg"), ovText: tok("--ov-text"), ovLine: tok("--ov-line"),
  ovChipBg: tok("--ov-chip-bg"), ovChipInk: tok("--ov-chip-ink"),
};
// cream as "R,G,B" for png_fit padding (extension popup sits on the site's cream)
const CREAM = (C.cream.replace("#", "").match(/../g) || []).map((h) => parseInt(h, 16)).join(",");

const FONTS = `<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&family=JetBrains+Mono:wght@500;700&display=swap" rel="stylesheet">`;

// shared brand chrome (background + framed logo row) used by both promo tiles
const brandBg = (frameInset, radius) => `
  body{font-family:"Inter",system-ui,sans-serif;color:${C.ink};
    background:
      radial-gradient(1200px 560px at 88% -12%, rgba(${C.rgb},0.18), transparent 60%),
      radial-gradient(820px 520px at -4% 118%, rgba(${C.rgb},0.10), transparent 60%),
      ${C.cream};position:relative;overflow:hidden}
  .frame{position:absolute;inset:${frameInset}px;border:1px solid ${C.line};border-radius:${radius}px}`;

const logo = (size, font) => `<div class="logo" style="width:${size}px;height:${size}px;border-radius:${Math.round(size * 0.26)}px;
  background:linear-gradient(160deg,${C.gradA},${C.gradB});display:flex;align-items:center;justify-content:center;
  font-family:'JetBrains Mono',monospace;font-weight:700;font-size:${font}px;color:#fff;
  box-shadow:0 10px 24px rgba(${C.rgb},0.34)">F$</div>`;

// ── the marquee (1400×560): copy + a REAL captured product screenshot ────────
const marqueeHtml = (demoB64) => `<!doctype html><html><head><meta charset="utf-8">${FONTS}<style>
  *{margin:0;padding:0;box-sizing:border-box} html,body{width:1400px;height:560px}
  ${brandBg(20, 26)}
  .pad{position:relative;height:100%;padding:46px 58px;display:flex;flex-direction:column}
  .top{display:flex;align-items:center;gap:15px}
  .wordmark{font-weight:800;font-size:27px;letter-spacing:-0.02em}
  .domain{margin-left:auto;font-family:"JetBrains Mono",monospace;font-weight:500;font-size:18px;color:${C.accentD};letter-spacing:.02em}
  .eyebrow{margin-top:34px;font-family:"JetBrains Mono",monospace;font-size:15px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:${C.accentD}}
  h1{font-weight:900;letter-spacing:-0.035em;line-height:1.0;font-size:60px;margin-top:14px}
  h1 .pop{color:${C.accentD}}
  .sub{margin-top:16px;font-size:22px;line-height:1.4;color:${C.ink2};font-weight:500;max-width:1180px}
  .sub b{color:${C.ink};font-weight:800}
  .demoWrap{margin-top:auto}
  .shot{width:100%;border-radius:16px;border:1px solid ${C.line};background:${C.tint};padding:14px 16px;box-shadow:0 18px 44px rgba(20,23,28,.12)}
  .shot img{width:100%;display:block;border-radius:8px}
</style></head><body><div class="frame"></div><div class="pad">
  <div class="top">${logo(58, 31)}<div class="wordmark">FreeAI.fyi</div><div class="domain">freeai.fyi</div></div>
  <div class="eyebrow">Chrome extension</div>
  <h1>Get Claude <span class="pop">for free.</span></h1>
  <p class="sub">A sponsored line shows while <b>ChatGPT, Claude &amp; Gemini</b> think — and <b>50% of the revenue</b> comes back to you as Claude Pro &amp; Max credits.</p>
  <div class="demoWrap"><div class="shot"><img src="data:image/png;base64,${demoB64}" alt="before/after"></div></div>
</div></body></html>`;

// ── the small promo tile (440×280): compact, legible at thumbnail size ───────
const smallHtml = () => `<!doctype html><html><head><meta charset="utf-8">${FONTS}<style>
  *{margin:0;padding:0;box-sizing:border-box} html,body{width:440px;height:280px}
  ${brandBg(11, 18)}
  .pad{position:relative;height:100%;padding:24px 26px;display:flex;flex-direction:column}
  .top{display:flex;align-items:center;gap:11px}
  .wordmark{font-weight:800;font-size:18px;letter-spacing:-0.02em}
  h1{font-weight:900;letter-spacing:-0.03em;line-height:1.02;font-size:33px;margin-top:18px}
  h1 .pop{color:${C.accentD}}
  .sub{margin-top:9px;font-size:14px;line-height:1.35;color:${C.gray};font-weight:600}
  .sub b{color:${C.accentD};font-weight:800}
  .pill{margin-top:auto;display:inline-flex;align-items:center;gap:10px;white-space:nowrap;
    background:${C.ovBg};color:${C.ovText};border:1px solid rgba(255,255,255,0.06);border-radius:12px;
    padding:11px 14px;font-size:14px;font-weight:600;box-shadow:0 12px 28px rgba(20,23,28,.20);align-self:flex-start}
  .pill .chip{width:24px;height:24px;border-radius:6px;flex:none;background:${C.ovChipBg};color:${C.ovChipInk};
    display:flex;align-items:center;justify-content:center;font-family:'JetBrains Mono',monospace;font-weight:700;font-size:14px}
  .pill .line{color:${C.ovLine}} .pill .name{font-weight:700}
</style></head><body><div class="frame"></div><div class="pad">
  <div class="top">${logo(34, 19)}<div class="wordmark">FreeAI.fyi</div></div>
  <h1>Get Claude <span class="pop">for free.</span></h1>
  <p class="sub"><b>50%</b> of the ad revenue comes back as Claude credits.</p>
  <div class="pill"><span class="chip">L</span> <span class="name">Linear</span> <span class="line">· Plan your next sprint faster</span></div>
</div></body></html>`;

// ── throwaway static server so we can screenshot the live site ───────────────
const MIME = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".mjs": "text/javascript",
  ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".webmanifest": "application/manifest+json" };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split("?")[0]);
  if (p === "/" || p.endsWith("/")) p += "index.html";
  try {
    const buf = readFileSync(join(ROOT, p));
    res.writeHead(200, { "content-type": MIME[extname(p)] || "application/octet-stream" });
    res.end(buf);
  } catch { res.writeHead(404); res.end("not found"); }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

const tmp = mkdtempSync(join(tmpdir(), "freeai-store-"));
const settle = async (page) => { await page.evaluate(() => document.fonts.ready).catch(() => {}); await page.waitForTimeout(700); };

const browser = await chromium.launch();
try {
  // live captures at 2× for crisp downscaling
  // The walking mascot (#claude-guy) is a transient animation — parked at a
  // random spot mid-capture it reads like an artifact, so hide it for clean shots.
  const HIDE = "#claude-guy{display:none!important}";
  const page = await browser.newPage({ viewport: { width: 1440, height: 980 }, deviceScaleFactor: 2 });
  await page.goto(`${base}/web/index.html`, { waitUntil: "load", timeout: 30000 });
  await page.addStyleTag({ content: HIDE });
  await settle(page);
  const demoPath = join(tmp, "demo.png");
  await (await page.$(".demo")).screenshot({ path: demoPath });
  const installPath = join(tmp, "install.png");
  await (await page.$("#install")).screenshot({ path: installPath });

  // homepage hero as a native 1280×800 viewport (2× → 2560×1600), then 50% down
  const hero = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
  await hero.goto(`${base}/web/index.html`, { waitUntil: "load", timeout: 30000 });
  await hero.addStyleTag({ content: HIDE });
  await settle(hero);
  const heroPath = join(tmp, "hero.png");
  await hero.screenshot({ path: heroPath });

  // promo tiles rendered at exact size (1×) with embedded real demo screenshot
  const demoB64 = readFileSync(demoPath).toString("base64");
  const marquee = await browser.newPage({ viewport: { width: 1400, height: 560 }, deviceScaleFactor: 1 });
  await marquee.setContent(marqueeHtml(demoB64), { waitUntil: "networkidle" });
  await marquee.evaluate(() => document.fonts.ready);
  const marqueePath = join(tmp, "marquee.png");
  await marquee.screenshot({ path: marqueePath, clip: { x: 0, y: 0, width: 1400, height: 560 } });

  const small = await browser.newPage({ viewport: { width: 440, height: 280 }, deviceScaleFactor: 1 });
  await small.setContent(smallHtml(), { waitUntil: "networkidle" });
  await small.evaluate(() => document.fonts.ready);
  const smallPath = join(tmp, "small.png");
  await small.screenshot({ path: smallPath, clip: { x: 0, y: 0, width: 440, height: 280 } });

  // ── extension popup, populated with sample data via a mocked chrome.* so it
  //    renders the real UI (fuel ring, crew, bid market), clipped into two
  //    states that png_fit pads onto cream → 640×400. ──
  const POP_STATE = { earnings: 3.26, impressions: 394, enabled: true, installedAt: Date.now() - 10 * 86400000, testMode: false };
  const POP_CREW = { linked: true, crewSize: 5, rewardPct: 10, creditedUsd: 0, friends: [],
    invited: [{ email: "c•••@gmail.com" }, { email: "v•••@yahoo.com" }, { email: "j•••@gmail.com" }] };
  const popup = await browser.newPage({ viewport: { width: 360, height: 1320 }, deviceScaleFactor: 2 });
  await popup.addInitScript(({ S, K }) => {
    window.chrome = {
      runtime: { lastError: undefined, sendMessage: (m, cb) => {
        const t = m && m.type; let r = {};
        if (t === "BB_GET_STATE") r = S; else if (t === "BB_GET_CREW") r = K; else if (t === "BB_GET_ADS") r = null;
        if (typeof cb === "function") cb(r);
      } },
      storage: { local: { get: () => Promise.resolve({}) } },
      tabs: { query: () => Promise.resolve([]), create: () => {}, sendMessage: () => {} },
    };
  }, { S: POP_STATE, K: POP_CREW });
  await popup.goto(`${base}/chrome-extension/popup/popup.html`, { waitUntil: "load" });
  await popup.evaluate(() => document.fonts && document.fonts.ready).catch(() => {});
  await popup.waitForTimeout(700);
  const pm = await popup.evaluate(() => {
    const W = document.body.offsetWidth, H = document.body.scrollHeight;
    const inv = [...document.querySelectorAll("#crew-slots .invited")];
    const aEnd = inv.length ? Math.ceil(inv[inv.length - 1].getBoundingClientRect().bottom) : Math.ceil(H * 0.5);
    const statsSec = document.querySelector(".stats")?.closest("section");
    const bStart = statsSec ? Math.floor(statsSec.getBoundingClientRect().top) : Math.floor(H * 0.6);
    const foot = document.querySelector(".foot");
    const bEnd = foot ? Math.ceil(foot.getBoundingClientRect().bottom) : H;
    return { W, H, aEnd, bStart, bEnd };
  });
  const popupAPath = join(tmp, "popup-a.png"), popupBPath = join(tmp, "popup-b.png");
  await popup.screenshot({ path: popupAPath, clip: { x: 0, y: 0, width: pm.W, height: pm.aEnd + 14 } });
  await popup.screenshot({ path: popupBPath, clip: { x: 0, y: pm.bStart - 12, width: pm.W, height: (pm.bEnd + 16) - (pm.bStart - 12) } });

  // ── finalize each to exact size / 24-bit no-alpha via the Python fitter ──
  const fit = (src, name, w, h, mode, bg, fmt) =>
    execFileSync("python3", [PNG_FIT, src, join(OUT, name), String(w), String(h), mode, bg, fmt], { stdio: "inherit" });

  const SS = join(ROOT, "screenshots");
  fit(ICON_SRC, "store-icon-128x128.png", 128, 128, "contain", "auto", "rgba");
  // chat-in-context screenshots (1280×800) — the ad while the AI thinks
  fit(join(SS, "ChatGPT Browser Thinking Cropped.png"), "screenshot-chatgpt-1280x800.png", 1280, 800, "contain", "auto", "rgb");
  fit(join(SS, "Claude Browser Thinking Small.png"), "screenshot-claude-1280x800.png", 1280, 800, "contain", "auto", "rgb");
  fit(join(SS, "Gemini Browser Thinking.png"), "screenshot-gemini-1280x800.png", 1280, 800, "contain", "auto", "rgb");
  // live site screenshots (1280×800)
  fit(heroPath, "screenshot-hero-1280x800.png", 1280, 800, "cover", "auto", "rgb");
  fit(installPath, "screenshot-install-1280x800.png", 1280, 800, "contain", "auto", "rgb");
  // extension popup states on cream (640×400)
  fit(popupAPath, "screenshot-popup-credits-640x400.png", 640, 400, "contain", CREAM, "rgb");
  fit(popupBPath, "screenshot-popup-market-640x400.png", 640, 400, "contain", CREAM, "rgb");
  // promo tiles
  fit(marqueePath, "marquee-1400x560.png", 1400, 560, "contain", "white", "rgb");
  fit(smallPath, "promo-small-440x280.png", 440, 280, "contain", "white", "rgb");
  console.log("\ngen-store-assets: store-assets/ regenerated.");
} finally {
  await browser.close();
  server.close();
  rmSync(tmp, { recursive: true, force: true });
}
