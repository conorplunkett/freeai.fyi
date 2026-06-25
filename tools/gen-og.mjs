// Generate the FreeAI.fyi social share / link-preview image — og.png (1200×630).
//
// This is the picture every platform (iMessage, Slack, Discord, WhatsApp,
// Twitter/X, Facebook, LinkedIn, Telegram…) shows when someone pastes a
// freeai.fyi link. It has one job: make it instantly obvious what the product
// does. So it leans on the product's own signature metaphor — the "Stock Claude
// → With FreeAI" before/after spinner from the landing page — plus the one-line
// pitch and the 50%-back promise.
//
// Like tools/gen-icons.py, this drives a local Chromium (real font rendering)
// rather than pulling an image toolchain. Colors are read straight from the
// design-system source of truth, theme.css, so the card can never drift from
// the palette (AGENTS.md ▸ Design system — never hardcode a color).
//
// Writes (overwrites):  og.png  at the repo root.
// Run:  make og   (or:  node tools/gen-og.mjs)

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

// Playwright is installed globally in this repo's tooling; resolve it from the
// global node_modules so we don't need a local dependency.
const require = createRequire(import.meta.url);
let chromium;
for (const spec of [
  "playwright",
  "/opt/node22/lib/node_modules/playwright",
  "playwright-core",
]) {
  try {
    ({ chromium } = require(spec));
    break;
  } catch {
    /* try next */
  }
}
if (!chromium) {
  console.error(
    "gen-og: Playwright not found. Install it (npm i -g playwright) and run again.",
  );
  process.exit(1);
}

// ── Pull the tokens we need straight out of theme.css's :root block ──────────
// We resolve one level of `var(--x)` aliasing so legacy names still work.
const themeCss = readFileSync(join(root, "web", "theme.css"), "utf8");
const rootBlock = themeCss.slice(themeCss.indexOf(":root"));
const raw = {};
for (const m of rootBlock.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
  raw[m[1]] = m[2].trim();
}
const tok = (name) => {
  let v = raw[name];
  const ref = v && v.match(/^var\((--[\w-]+)\)$/);
  if (ref) v = raw[ref[1]];
  if (v == null) throw new Error(`gen-og: token ${name} not found in theme.css`);
  return v.trim();
};

const C = {
  accent: tok("--accent"),
  accentD: tok("--accent-d"),
  gradA: tok("--accent-grad-a"),
  gradB: tok("--accent-grad-b"),
  accentRGB: tok("--accent-rgb"),
  cream: tok("--bg-cream"),
  tint: tok("--bg-tint"),
  ink: tok("--ink"),
  ink2: tok("--ink-2"),
  gray: tok("--gray"),
  gray2: tok("--gray-2"),
  line: tok("--line"),
  ovBg: tok("--ov-bar-bg"),
  ovLine: tok("--ov-line"),
  ovText: tok("--ov-text"),
  ovChipBg: tok("--ov-chip-bg"),
  ovChipInk: tok("--ov-chip-ink"),
};

// ── The card markup. Fixed at exactly the OpenGraph canonical size, 1200×630
// (1.91:1). All variants share one layout + palette; only the eyebrow + headline
// + subhead copy change, so every preview is unmistakably the same product. ──
const cardHtml = ({ eyebrow, h1, sub, demo = true }) => `<!doctype html><html><head><meta charset="utf-8">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&family=JetBrains+Mono:wght@500;700&display=swap" rel="stylesheet">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: 1200px; height: 630px; }
  body {
    font-family: "Inter", system-ui, sans-serif;
    color: ${C.ink};
    background:
      radial-gradient(1100px 520px at 86% -8%, rgba(${C.accentRGB}, 0.16), transparent 60%),
      radial-gradient(760px 460px at 4% 116%, rgba(${C.accentRGB}, 0.10), transparent 60%),
      ${C.cream};
    position: relative;
    overflow: hidden;
  }
  /* hairline frame so the card reads as a deliberate object on any chat bg */
  .frame { position: absolute; inset: 22px; border: 1px solid ${C.line}; border-radius: 28px; }
  .pad { position: relative; padding: 64px 72px; height: 100%; display: flex; flex-direction: column; }

  .top { display: flex; align-items: center; gap: 16px; }
  .logo {
    width: 64px; height: 64px; border-radius: 16px;
    background: linear-gradient(160deg, ${C.gradA}, ${C.gradB});
    display: flex; align-items: center; justify-content: center;
    font-family: "JetBrains Mono", monospace; font-weight: 700; font-size: 34px; color: #fff;
    box-shadow: 0 10px 26px rgba(${C.accentRGB}, 0.34);
  }
  .wordmark { font-weight: 800; font-size: 30px; letter-spacing: -0.02em; }
  .domain { margin-left: auto; font-family: "JetBrains Mono", monospace; font-weight: 500;
    font-size: 19px; color: ${C.accentD}; letter-spacing: 0.02em; }

  .eyebrow { margin-top: 40px; font-family: "JetBrains Mono", monospace; font-size: 17px;
    font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; color: ${C.accentD}; }
  h1 { font-weight: 900; letter-spacing: -0.035em; line-height: 1.02; font-size: 76px; margin-top: 38px; }
  h1.with-eyebrow { margin-top: 10px; }
  h1 .pop { color: ${C.accentD}; }
  .sub { margin-top: 22px; font-size: 27px; line-height: 1.38; color: ${C.ink2}; font-weight: 500; max-width: 880px; }
  .sub b { color: ${C.ink}; font-weight: 800; }

  .demo { margin-top: auto; display: flex; align-items: center; gap: 18px; }
  .card { display: flex; flex-direction: column; gap: 12px; }
  .label { font-family: "JetBrains Mono", monospace; font-size: 15px; font-weight: 700;
    letter-spacing: 0.12em; text-transform: uppercase; color: ${C.gray}; }
  .pill {
    display: inline-flex; align-items: center; gap: 12px; white-space: nowrap;
    background: ${C.ovBg}; color: ${C.ovText};
    border: 1px solid rgba(255,255,255,0.06);
    border-radius: 14px; padding: 16px 22px; font-size: 22px; font-weight: 600;
    box-shadow: 0 14px 34px rgba(20, 23, 28, 0.20);
  }
  .pill .ast { color: ${C.accent}; font-size: 22px; }
  .pill .dots { color: ${C.gray2}; }
  .pill .line { color: ${C.ovLine}; }
  .chip {
    width: 30px; height: 30px; border-radius: 8px; flex: none;
    background: ${C.ovChipBg}; color: ${C.ovChipInk};
    display: flex; align-items: center; justify-content: center;
    font-family: "JetBrains Mono", monospace; font-weight: 700; font-size: 18px;
  }
  .arrow { font-size: 40px; color: ${C.accent}; font-weight: 800; align-self: center; margin-top: 18px; }

  /* Demo-less "simple" card: vertically center the headline block instead of
     anchoring it to the top, so it reads as deliberate, not top-heavy. */
  .mid { flex: 1; display: flex; flex-direction: column; justify-content: center; }
  .mid .eyebrow, .mid h1 { margin-top: 0; }
  .mid .eyebrow { margin-bottom: 14px; }
</style></head>
<body>
  <div class="frame"></div>
  <div class="pad">
    <div class="top">
      <div class="logo">F$</div>
      <div class="wordmark">FreeAI.fyi</div>
      <div class="domain">freeai.fyi</div>
    </div>
${
  demo
    ? `
    ${eyebrow ? `<div class="eyebrow">${eyebrow}</div>` : ""}
    <h1 class="${eyebrow ? "with-eyebrow" : ""}">${h1}</h1>
    <p class="sub">${sub}</p>

    <div class="demo">
      <div class="card">
        <div class="label">Stock Claude</div>
        <div class="pill"><span class="ast">✳</span> Thinking<span class="dots">…</span></div>
      </div>
      <div class="arrow">»</div>
      <div class="card">
        <div class="label">With FreeAI</div>
        <div class="pill"><span class="chip">R</span> <span class="line">Ramp · Spend smarter</span></div>
      </div>
    </div>`
    : `
    <div class="mid">
      ${eyebrow ? `<div class="eyebrow">${eyebrow}</div>` : ""}
      <h1>${h1}</h1>
      ${sub ? `<p class="sub">${sub}</p>` : ""}
    </div>`
}
  </div>
</body></html>`;

// Every link-preview image we ship. The default (og.png) is the homepage card;
// og-referral.png is the invite card a member's referral link
// (redeem.html?ref=…) previews as — so a shared invite reads as "your free
// month of Claude" rather than the generic sign-in page.
const CARDS = [
  {
    file: "og.png",
    h1: `Get Claude <span class="pop">for free.</span>`,
    sub: `A subtle sponsored line shows while <b>ChatGPT, Claude &amp; Gemini</b> think — and <b>50% of the revenue</b> comes back to you as Claude Pro &amp; Max credits.`,
  },
  {
    file: "og-referral.png",
    demo: false,
    eyebrow: "A friend invited you",
    h1: `Get a <span class="pop">free month</span> of Claude.`,
    sub: `Free to start — keep using the AI you already use.`,
  },
];

// Output exactly the OpenGraph canonical size, 1200×630. Staying at 1× keeps the
// PNG small (~150KB) — below WhatsApp's ~300KB rich-preview threshold, so the
// big card (not a tiny thumbnail) shows in chat apps — while matching the
// og:image:width/height we advertise so no platform second-guesses the crop.
const SCALE = 1;

const browser = await chromium.launch();
try {
  const page = await browser.newPage({
    viewport: { width: 1200, height: 630 },
    deviceScaleFactor: SCALE,
  });
  for (const card of CARDS) {
    await page.setContent(cardHtml(card), { waitUntil: "networkidle" });
    // Make sure the web fonts have actually painted before we snapshot.
    await page.evaluate(() => document.fonts.ready);
    const out = join(root, "web", card.file);
    await page.screenshot({ path: out, clip: { x: 0, y: 0, width: 1200, height: 630 } });
    console.log(`gen-og: wrote ${card.file} (1200×630 @${SCALE}x) → ${out}`);
  }
} finally {
  await browser.close();
}

// Quiet the unused import lint — pathToFileURL kept for parity with sibling tools.
void pathToFileURL;
