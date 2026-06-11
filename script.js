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

// --- Sponsored ad rotation (the "with betterbacks" line) ---
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
