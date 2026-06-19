// --- Live ticker (top banner) ---
// Seeded with mock winning bids. When the API is wired, the leaderboard feed
// can populate this the same way loadLeaderboard() fills the board below.
// Each entry carries a little brand logo chip (initial + brand color) shown
// before the name in the moving banner.
const TICKER_ADS = [
  { brand: "Ramp", logo: "R", color: "#ffd54a", ink: "#1b1e25", text: "Save time and money on every dollar you spend" },
  { brand: "Linear", logo: "L", color: "#5b5bd6", ink: "#fff", text: "Issue tracking built for high-performance teams" },
  { brand: "Vercel", logo: "△", color: "#000", ink: "#fff", text: "Ship your agent to production in seconds" },
  { brand: "Neon", logo: "N", color: "#00e599", ink: "#04130a", text: "Serverless Postgres your agent can branch" },
  { brand: "Resend", logo: "R", color: "#111", ink: "#fff", text: "The email API built for developers" },
  { brand: "Fluidstack", logo: "F", color: "#1d6cff", ink: "#fff", text: "Building 10GW of compute. Join us." },
  { brand: "Tuple", logo: "T", color: "#5d5fef", ink: "#fff", text: "Remote pair programming, done right" },
  { brand: "Stripe", logo: "S", color: "#635bff", ink: "#fff", text: "Financial infrastructure for the internet" },
];
(function buildTicker() {
  const track = document.getElementById("ticker-track");
  if (!track) return;
  const cell = (ad) =>
    `<span class="tick">` +
    `<span class="tick-logo" style="background:${ad.color};color:${ad.ink}">${ad.logo}</span>` +
    `<span class="tick-brand">${ad.brand}</span>` +
    `<span class="tick-text">${ad.text}</span></span>`;
  // Duplicate the run so the -50% scroll loops seamlessly.
  const run = TICKER_ADS.map(cell).join("");
  track.innerHTML = run + run;
})();

// --- Stock-side spinner word rotation (the "before" card) ---
const STOCK_WORDS = [
  "Baking", "Discombobulating", "Percolating", "Simmering", "Marinating",
  "Computing", "Vibing", "Noodling", "Ruminating", "Conjuring",
];
let sw = 0;
const wordStock = document.getElementById("word-stock");
if (wordStock) {
  setInterval(() => {
    sw = (sw + 1) % STOCK_WORDS.length;
    wordStock.textContent = STOCK_WORDS[sw];
  }, 1600);
}

// --- Little Claude Code guy hanging out behind the ad bar ---
// He idles (bobbing + blinking via CSS) and every few seconds either shuffles
// along the right end of the bar, ducks down behind it, or does a tiny hop.
const claudeGuy = document.getElementById("claude-guy");
if (claudeGuy) {
  const wander = () => {
    const roll = Math.random();
    if (roll < 0.4) {
      // shuffle to a new spot, staying near the far right end
      claudeGuy.style.right = Math.round(16 + Math.random() * 95) + "px";
    } else if (roll < 0.6) {
      // shy — duck behind the bar for a moment
      claudeGuy.classList.add("cg-duck");
      setTimeout(() => claudeGuy.classList.remove("cg-duck"), 1700);
    } else {
      // lil hop
      claudeGuy.classList.add("cg-hop");
      setTimeout(() => claudeGuy.classList.remove("cg-hop"), 600);
    }
    setTimeout(wander, 2800 + Math.random() * 3200);
  };
  setTimeout(wander, 2200);
}

// --- Sponsored ad rotation (the "with freeai" line) ---
// Sponsored lines for the "With FreeAI" card. Each chip carries the sponsor's
// own brand color; copy follows one house style — "Brand · Sentence-case line"
// with a middot separator — to stay consistent with TICKER_ADS above.
const ADS = [
  { chip: "R", color: "#ffd54a", ink: "#1b1e25", text: "Ramp · Save time and money" },
  { chip: "L", color: "#5b5bd6", ink: "#fff", text: "Linear · Issue tracking built for speed" },
  { chip: "△", color: "#000", ink: "#fff", text: "Vercel · Ship your agent to prod" },
  { chip: "N", color: "#00e599", ink: "#04130a", text: "Neon · Postgres your agent can branch" },
  { chip: "R", color: "#111", ink: "#fff", text: "Resend · Email built for developers" },
  { chip: "F", color: "#1d6cff", ink: "#fff", text: "Fluidstack · Building 10GW of compute" },
];
let ai = 0;
const rotator = document.getElementById("brand-line");
const chip = document.querySelector(".brandchip");
// Paint the first ad immediately so the "With FreeAI" line is never empty,
// even before the first rotation tick.
if (rotator && chip) {
  const first = ADS[0];
  rotator.textContent = first.text;
  chip.textContent = first.chip;
  chip.style.background = first.color;
  chip.style.color = first.ink;
  rotator.style.opacity = "1";
  chip.style.opacity = "1";
}
setInterval(() => {
  ai = (ai + 1) % ADS.length;
  const ad = ADS[ai];
  if (!rotator || !chip) return;
  rotator.style.opacity = "0";
  chip.style.opacity = "0";
  setTimeout(() => {
    rotator.textContent = ad.text;
    chip.textContent = ad.chip;
    chip.style.background = ad.color;
    chip.style.color = ad.ink;
    rotator.style.opacity = "1";
    chip.style.opacity = "1";
  }, 260);
}, 2600);
if (rotator) { rotator.style.transition = "opacity .26s"; }
if (chip) { chip.style.transition = "opacity .26s, background .26s"; }

// --- Hero earnings pill: gently ticks up ---
const earnPill = document.getElementById("earn-pill");
let earn = 76.71;
setInterval(() => {
  earn += Math.random() * 0.14;
  if (earnPill) earnPill.innerHTML = "$" + earn.toFixed(2) + '<span class="per">/mo</span>';
}, 1400);

// --- Ad line character counter ---
const adline = document.getElementById("adline");
const adlineCount = document.getElementById("adline-count");
if (adline) {
  adline.addEventListener("input", () => {
    adlineCount.textContent = `${adline.value.length} / 60`;
  });
}

// --- Live bid / estimate calculator ---
const priceEl = document.getElementById("price");
const blocksEl = document.getElementById("blocks");
const fmt = (n) => "$" + n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtInt = (n) => n.toLocaleString();

function recalc() {
  const price = Math.max(1, parseFloat(priceEl.value) || 0);
  const blocks = Math.max(1, parseInt(blocksEl.value) || 0);
  const total = price * blocks;
  const imp = blocks * 1000;
  document.getElementById("est-sub").textContent =
    `${blocks} block${blocks > 1 ? "s" : ""} at ${fmt(price)}`;
  document.getElementById("est-total").textContent = fmt(total);
  document.getElementById("est-per").textContent = fmt(price);
  document.getElementById("est-blocks").textContent = fmtInt(blocks);
  document.getElementById("est-imp").textContent = fmtInt(imp);
}
if (priceEl && blocksEl) {
  priceEl.addEventListener("input", recalc);
  blocksEl.addEventListener("input", recalc);
  recalc();
}

// --- Copy install command ---
document.querySelectorAll(".copy-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    const text = btn.getAttribute("data-copy");
    navigator.clipboard?.writeText(text);
    const old = btn.textContent;
    btn.textContent = "Copied!";
    setTimeout(() => (btn.textContent = old), 1400);
  });
});

// --- API wiring ---------------------------------------------------------
// In production the leaderboard + advertiser checkout point at the live backend
// (set via <meta name="freeai-api"> in index.html, or window.FREEAI_API).
//
// Developer mode: append ?dev=1 to the URL to flip the lander into its
// self-contained mock-data mode (hardcoded leaderboard/ticker/hero, no network);
// it sticks via localStorage, and ?dev=0 turns it back off. A small badge makes
// the mode obvious. This is the "easy on-switch" for showing mock data on the
// lander without touching prod.
const DEV_MODE = (() => {
  const flag = new URLSearchParams(location.search).get("dev");
  try {
    if (flag === "1") { localStorage.setItem("freeai_dev", "1"); return true; }
    if (flag === "0") { localStorage.removeItem("freeai_dev"); return false; }
    return localStorage.getItem("freeai_dev") === "1";
  } catch (_) {
    return flag === "1";
  }
})();

// In dev mode we deliberately drop the API base so loadLeaderboard() and the bid
// form fall back to the page's built-in mock data (no network calls at all).
const API_BASE = DEV_MODE
  ? ""
  : (
      window.FREEAI_API ||
      document.querySelector('meta[name="freeai-api"]')?.content ||
      ""
    ).replace(/\/+$/, "");

if (DEV_MODE) {
  const badge = document.createElement("div");
  badge.textContent = "DEV · mock data";
  badge.title = "Developer mode — mock data, no live API. Append ?dev=0 to exit.";
  badge.style.cssText =
    "position:fixed;bottom:14px;left:14px;z-index:99999;background:#1b1e25;color:#ffd54a;" +
    "font:600 12px/1 ui-monospace,SFMono-Regular,Menlo,monospace;padding:8px 12px;border-radius:999px;" +
    "border:1px solid #ffd54a;box-shadow:0 4px 16px rgba(0,0,0,.25);letter-spacing:.02em;";
  (document.body || document.documentElement).appendChild(badge);
}

const escapeHtml = (s) =>
  String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// Pull the live bid market into the leaderboard (escaped — advertiser text).
async function loadLeaderboard() {
  if (!API_BASE) return;
  const board = document.getElementById("board");
  if (!board) return;
  try {
    const res = await fetch(`${API_BASE}/v1/leaderboard`);
    if (!res.ok) return;
    const { leaderboard } = await res.json();
    if (!Array.isArray(leaderboard) || !leaderboard.length) return;
    board.innerHTML = leaderboard
      .map((r) => `<li><span class="rk">${r.rank}</span> ${escapeHtml(r.line)}</li>`)
      .join("");
  } catch (_) {
    /* offline — keep the demo leaderboard */
  }
}
loadLeaderboard();

// Real advertiser checkout: create a campaign + redirect to Stripe.
const adForm = document.querySelector(".adform");
if (adForm) {
  adForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const stripeBtn = adForm.querySelector(".stripe-btn");
    const get = (sel) => adForm.querySelector(sel)?.value?.trim() || "";
    const payload = {
      email: get('input[type="email"]'),
      adLine: document.getElementById("adline")?.value?.trim() || "",
      url: get('input[type="url"]'),
      brand: adForm.querySelector('input[placeholder="Linear"]')?.value?.trim() || "",
      pricePerBlock: parseFloat(document.getElementById("price")?.value || "0"),
      blocks: parseInt(document.getElementById("blocks")?.value || "0", 10),
      showOnLeaderboard: adForm.querySelector('input[type="checkbox"]')?.checked !== false,
    };

    if (!API_BASE) {
      // No API configured. This is the live page, so surface a neutral retry
      // message rather than any demo/test wording.
      const old = stripeBtn.innerHTML;
      stripeBtn.textContent = "Couldn't reach checkout — try again";
      setTimeout(() => (stripeBtn.innerHTML = old), 2200);
      return;
    }
    stripeBtn.disabled = true;
    const old = stripeBtn.innerHTML;
    stripeBtn.textContent = "Redirecting to Stripe…";
    try {
      const res = await fetch(`${API_BASE}/v1/checkout`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (res.ok && data.checkoutUrl) {
        window.location.href = data.checkoutUrl;
      } else {
        stripeBtn.textContent = data.error || "Something went wrong";
        setTimeout(() => { stripeBtn.innerHTML = old; stripeBtn.disabled = false; }, 2600);
      }
    } catch (_) {
      stripeBtn.textContent = "Network error — try again";
      setTimeout(() => { stripeBtn.innerHTML = old; stripeBtn.disabled = false; }, 2600);
    }
  });
}
