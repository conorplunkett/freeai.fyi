// --- Live ticker (top banner) ---
// Seeded with mock winning bids. When the API is wired, the leaderboard feed
// can populate this the same way loadLeaderboard() fills the board below.
const TICKER_ADS = [
  { brand: "Ramp", text: "Save time and money on every dollar you spend" },
  { brand: "Linear", text: "Issue tracking built for high-performance teams" },
  { brand: "Vercel", text: "Ship your agent to production in seconds" },
  { brand: "Neon", text: "Serverless Postgres your agent can branch" },
  { brand: "Resend", text: "The email API built for developers" },
  { brand: "Fluidstack", text: "Building 10GW of compute. Join us." },
  { brand: "Tuple", text: "Remote pair programming, done right" },
  { brand: "Stripe", text: "Financial infrastructure for the internet" },
];
(function buildTicker() {
  const track = document.getElementById("ticker-track");
  if (!track) return;
  const cell = (ad) =>
    `<span class="tick"><span class="tick-brand">${ad.brand}</span>` +
    `<span class="tick-text">${ad.text}</span></span>`;
  // Duplicate the run so the -50% scroll loops seamlessly.
  const run = TICKER_ADS.map(cell).join("");
  track.innerHTML = run + run;
})();

// --- Spinner word rotation (stock Claude Code vibes) ---
const STOCK_WORDS = [
  "Baking", "Discombobulating", "Percolating", "Simmering", "Marinating",
  "Computing", "Vibing", "Noodling", "Ruminating", "Conjuring",
];
let sw = 0;
const wordStock = document.getElementById("word-stock");
setInterval(() => {
  sw = (sw + 1) % STOCK_WORDS.length;
  if (wordStock) wordStock.textContent = STOCK_WORDS[sw];
}, 1600);

// --- Sponsored ad rotation (the "with freeai" line) ---
const ADS = [
  { chip: "R", color: "#ffd54a", ink: "#1b1e25", text: "Ramp · save time and money" },
  { chip: "L", color: "#5b5bd6", ink: "#fff", text: "Linear — issue tracking built for speed" },
  { chip: "△", color: "#000", ink: "#fff", text: "Vercel · ship your agent to prod" },
  { chip: "N", color: "#00e599", ink: "#04130a", text: "Neon · Postgres your agent can branch" },
  { chip: "R", color: "#111", ink: "#fff", text: "Resend — email for developers" },
  { chip: "F", color: "#1d6cff", ink: "#fff", text: "Fluidstack — building 10GW of compute" },
];
let ai = 0;
const rotator = document.getElementById("ad-rotator");
const chip = document.querySelector(".brandchip");
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
// Set window.FREEAI_API (or a <meta name="freeai-api">) to point the
// bid form and leaderboard at the live backend. With no API configured, the
// page stays in its self-contained demo mode (hardcoded leaderboard, no
// network) so it works anywhere.
const API_BASE = (
  window.FREEAI_API ||
  document.querySelector('meta[name="freeai-api"]')?.content ||
  ""
).replace(/\/+$/, "");

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
      // demo mode: no backend configured
      const old = stripeBtn.innerHTML;
      stripeBtn.textContent = "Demo mode — connect the API to take payments";
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
