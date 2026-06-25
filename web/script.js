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
const prefersReducedMotion =
  window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
if (claudeGuy && !prefersReducedMotion) {
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
// Keep each line short — it must fit ONE line in the demo card at both desktop
// and mobile widths (verified per-ad; see styles.css .brand-line).
const ADS = [
  { chip: "R", color: "#ffd54a", ink: "#1b1e25", text: "Ramp · Spend smarter" },
  { chip: "L", color: "#5b5bd6", ink: "#fff", text: "Linear · Issue tracking" },
  { chip: "△", color: "#000", ink: "#fff", text: "Vercel · Ship to prod" },
  { chip: "N", color: "#00e599", ink: "#04130a", text: "Neon · Postgres, branched" },
  { chip: "R", color: "#111", ink: "#fff", text: "Resend · Email for devs" },
  { chip: "F", color: "#1d6cff", ink: "#fff", text: "Fluidstack · GPU compute" },
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

// --- Ad color: keep the swatch picker and the #hex text field in sync ---
const adcolor = document.getElementById("adcolor");
const adcolorSwatch = document.getElementById("adcolor-swatch");
if (adcolor && adcolorSwatch) {
  const isHex = (v) => /^#[0-9a-f]{6}$/i.test(v);
  // Picker → text: write the chosen hex (lowercase, with #).
  adcolorSwatch.addEventListener("input", () => {
    adcolor.value = adcolorSwatch.value.toLowerCase();
  });
  // Text → picker: mirror a complete #rrggbb into the swatch. The field is
  // optional, so a blank or mid-typing value just leaves the swatch as-is.
  adcolor.addEventListener("input", () => {
    const v = adcolor.value.trim();
    const hex = v.startsWith("#") ? v : `#${v}`;
    if (isHex(hex)) adcolorSwatch.value = hex.toLowerCase();
  });
}

// --- Live ad preview: mirror the spinner overlay as the advertiser types ---
const adPrevBar = document.getElementById("adpreview-bar");
function readableInk(hex) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex || "");
  if (!m) return "#fff";
  const [r, g, b] = [1, 2, 3].map((i) => parseInt(m[i], 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.62 ? "#1b1e25" : "#fff"; // dark ink on light chips
}
function updateAdPreview() {
  if (!adPrevBar) return;
  const form = document.querySelector(".adform");
  const brand = (form?.querySelector('input[name="organization"]')?.value || "").trim();
  const line = (document.getElementById("adline")?.value || "").trim();
  const raw = (document.getElementById("adcolor")?.value || "").trim();
  const hex = /^#?[0-9a-f]{6}$/i.test(raw) ? (raw[0] === "#" ? raw : "#" + raw) : "";
  const accent = hex || getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#d97757";
  const chip = document.getElementById("prev-chip");
  const lineEl = document.getElementById("prev-line");
  if (chip) chip.textContent = ((brand || line || "Your ad here").trim()[0] || "Y").toUpperCase();
  if (lineEl) lineEl.textContent = line || "Your ad here";
  adPrevBar.style.setProperty("--prev-accent", accent);
  adPrevBar.style.setProperty("--prev-ink", readableInk(accent));
}
{
  const form = document.querySelector(".adform");
  if (form && adPrevBar) { form.addEventListener("input", updateAdPreview); updateAdPreview(); }
}

// --- Destination URL: accept bare domains by auto-adding https:// ---
// The backend requires https://, so prepend the scheme when the advertiser
// tabs out of the field (and again on submit), and upgrade a typed http://.
function normalizeUrl(raw) {
  const v = (raw || "").trim();
  if (!v) return "";
  if (/^https:\/\//i.test(v)) return v;
  if (/^http:\/\//i.test(v)) return v.replace(/^http:\/\//i, "https://");
  if (/^\/\//.test(v)) return "https:" + v; // protocol-relative //host
  return "https://" + v;
}
const urlInput = document.querySelector('.adform input[name="url"]');
if (urlInput) {
  urlInput.addEventListener("blur", () => { urlInput.value = normalizeUrl(urlInput.value); });
}

// --- Budget + CPM estimate calculator ---
// Advertiser sets a budget and a CPM (cost per 1,000 impressions); they pay the
// full budget and get floor(budget*1000/cpm) impressions. CPM drives the auction.
const budgetEl = document.getElementById("budget");
const cpmEl = document.getElementById("cpm");
const cpmBubble = document.getElementById("cpm-bubble");
const fmt = (n) => "$" + n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtInt = (n) => n.toLocaleString();

let MIN_BUDGET = 100, MAX_BUDGET = 100000, SUGGESTED_BUDGET = 2500, MIN_CPM = 5, MAX_CPM = 100; // overridden by loadPricing()
const setTxt = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };

function positionCpmBubble() {
  if (!cpmEl || !cpmBubble) return;
  const min = Number(cpmEl.min) || MIN_CPM, max = Number(cpmEl.max) || MAX_CPM;
  const val = Number(cpmEl.value) || min;
  const pct = max > min ? (val - min) / (max - min) : 0;
  // 22px thumb: nudge the bubble so it stays over the thumb at both ends.
  cpmBubble.style.left = `calc(${pct * 100}% + ${(0.5 - pct) * 22}px)`;
  cpmBubble.textContent = fmt(val);
}

function recompute() {
  if (!budgetEl || !cpmEl) return;
  // Blank budget falls back to the suggested (the placeholder), so the estimate
  // reflects the soft default until the advertiser types their own number.
  const raw = parseFloat(budgetEl.value);
  const budget = Math.min(MAX_BUDGET, Math.max(MIN_BUDGET, Number.isFinite(raw) && raw > 0 ? raw : SUGGESTED_BUDGET));
  const cpm = Math.max(MIN_CPM, parseInt(cpmEl.value, 10) || MIN_CPM);
  const impressions = Math.floor((budget * 1000) / cpm); // round down — advertiser pays full budget
  setTxt("est-cpm", fmt(cpm));
  setTxt("est-imp", fmtInt(impressions));
  // One-line summary above the pay button mirrors the budget box.
  setTxt("sum-budget", "$" + fmtInt(Math.round(budget)));
  setTxt("sum-cpm", fmt(cpm));
  setTxt("sum-imp", fmtInt(impressions));
  positionCpmBubble();
}
if (budgetEl && cpmEl) {
  budgetEl.addEventListener("input", recompute);
  cpmEl.addEventListener("input", recompute);
  // Don't let the mouse wheel scrub the budget number — scroll the page instead.
  budgetEl.addEventListener("wheel", (e) => { if (document.activeElement === budgetEl) e.preventDefault(); }, { passive: false });
  recompute();
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
// The whole section is hidden by default; it's only revealed when the admin has
// turned the "Live bid market" switch on (surfaced via /v1/config →
// leaderboardPublic). Dev/offline mode keeps it hidden.
async function loadLeaderboard() {
  const section = document.getElementById("leaderboard");
  const board = document.getElementById("board");
  if (!section || !board || !API_BASE) return;
  try {
    const cfg = await fetch(`${API_BASE}/v1/config`).then((r) => (r.ok ? r.json() : null));
    if (!cfg || !cfg.leaderboardPublic) return; // switch is off — stay hidden
    const res = await fetch(`${API_BASE}/v1/leaderboard`);
    if (res.ok) {
      const { leaderboard } = await res.json();
      if (Array.isArray(leaderboard) && leaderboard.length) {
        board.innerHTML = leaderboard
          .map((r) => `<li><span class="rk">${r.rank}</span> ${escapeHtml(r.line)}</li>`)
          .join("");
      }
    }
    section.hidden = false; // reveal now that we know it's public
  } catch (_) {
    /* offline — keep it hidden */
  }
}
loadLeaderboard();

// Pull admin-tunable pricing (CPM min/suggested/max/top + budget min/suggested/max)
// from /v1/pricing and reflect it in the form + estimate. Falls back to the
// hardcoded defaults if the API is unreachable.
async function loadPricing() {
  if (!API_BASE) return;
  try {
    const res = await fetch(`${API_BASE}/v1/pricing`);
    if (!res.ok) return;
    const c = await res.json();
    const dollars = (cents, fallback) => (Number.isFinite(cents) ? cents / 100 : fallback);
    const minCpm = dollars(c.minCpmCents ?? c.minBidCents, 5);
    const sugCpm = dollars(c.suggestedCpmCents ?? c.suggestedBidCents, 15);
    const topCpm = dollars(c.topCpmCents ?? c.topBidCents, 110);
    const maxCpm = dollars(c.maxCpmCents, 100);
    const minBudget = dollars(c.minBudgetCents, 100);
    const sugBudget = dollars(c.suggestedBudgetCents, 2500);
    const maxBudget = dollars(c.maxBudgetCents, 100000);
    const money = (n) => "$" + n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const money0 = (n) => "$" + Math.round(n).toLocaleString();

    MIN_CPM = minCpm; MAX_CPM = maxCpm; MIN_BUDGET = minBudget; MAX_BUDGET = maxBudget; SUGGESTED_BUDGET = sugBudget;
    // Start the slider at the suggested CPM (no "suggested" label shown).
    if (cpmEl) { cpmEl.min = minCpm; cpmEl.max = maxCpm; cpmEl.value = sugCpm; }
    // Budget stays blank; the suggested becomes the placeholder + the soft default.
    if (budgetEl) { budgetEl.min = String(minBudget); budgetEl.max = String(maxBudget); budgetEl.placeholder = String(Math.round(sugBudget)); }
    setTxt("budget-hint", `min ${money0(minBudget)} · max ${money0(maxBudget)}`);
    setTxt("cpm-min-lbl", money0(minCpm));
    setTxt("cpm-top-lbl", money0(topCpm));
    setTxt("note-top", money(topCpm));
    setTxt("note-min", money(minCpm));
    recompute();
  } catch (_) {
    /* offline — keep the hardcoded defaults */
  }
}
loadPricing();

// Real advertiser checkout: create a campaign + redirect to Stripe.
const adForm = document.querySelector(".adform");
if (adForm) {
  adForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const stripeBtn = adForm.querySelector(".stripe-btn");
    const get = (sel) => adForm.querySelector(sel)?.value?.trim() || "";
    const payload = {
      email: get('input[name="email"]'),
      adLine: document.getElementById("adline")?.value?.trim() || "",
      url: normalizeUrl(get('input[name="url"]')),
      brand: get('input[name="organization"]'),
      color: document.getElementById("adcolor")?.value?.trim() || "",
      budget: parseFloat(document.getElementById("budget")?.value || "0"),
      cpm: parseInt(document.getElementById("cpm")?.value || "0", 10),
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

// --- Waitlist email capture (hero) --------------------------------------
// Injected directly under the hero tagline on the home page AND every lander —
// they all load this file + styles.css, so this is the single source for the
// widget rather than 10 copies of divergent markup. Pre-account: it POSTs a bare
// email to /v1/waitlist (no login, no magic link). The "Want to advertise?"
// button just jumps to the on-page advertiser form (#advertisers exists on all
// of these pages). Where a lander already shows the big "FOR ADVERTISERS" jump
// chevron under the tagline, we hide it so there's exactly one advertiser CTA.
const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
// Tag each signup with the page it came from so a lead's `source` is useful
// later (e.g. "index", "lander:gemini").
function waitlistSource() {
  const slug = location.pathname.replace(/\/+$/, "").split("/").pop() || "index";
  if (!slug || /^index(\.html)?$/.test(slug)) return "index";
  return "lander:" + slug.replace(/\.html$/, "");
}
function initWaitlist() {
  const note = document.querySelector(".hero-note");
  if (!note || document.getElementById("wl")) return; // need a hero; inject once

  const wl = document.createElement("div");
  wl.className = "wl";
  wl.id = "wl";
  wl.innerHTML =
    '<div class="wl-row">' +
      '<form class="wl-form" id="wl-form" novalidate>' +
        '<input class="wl-input" id="wl-email" type="email" name="email" autocomplete="email" inputmode="email" placeholder="you@example.com" aria-label="Email for the FreeAI waitlist" required />' +
        '<button class="wl-btn" type="submit">Join waitlist</button>' +
      '</form>' +
      '<a class="wl-adv" href="#advertisers">Want to advertise?</a>' +
    '</div>' +
    // Kept (empty) so submit validation/errors still have somewhere to render;
    // .wl-note:empty collapses it so there's no default copy under the row.
    '<p class="wl-note" id="wl-note"></p>';
  // On the home page the waitlist sits BELOW the 3-up downloads grid (so "Get it
  // on your platform" reads directly under the hero note); the landers have no
  // downloads section, so it stays right under the hero note there. .wl--wide
  // widens the home variant to sit as one row under the three product columns.
  const downloads = document.querySelector(".downloads");
  if (downloads) {
    wl.classList.add("wl--wide");
    downloads.insertAdjacentElement("afterend", wl);
  } else {
    note.insertAdjacentElement("afterend", wl);
  }

  // Drop the redundant hero "FOR ADVERTISERS · BID ON THIS LINE" jump (landers
  // only) — the new "Want to advertise?" button now owns that jump.
  const jump = note.parentElement && note.parentElement.querySelector(".jump");
  if (jump) jump.style.display = "none";

  const form = wl.querySelector("#wl-form");
  const email = wl.querySelector("#wl-email");
  const btn = wl.querySelector(".wl-btn");
  const noteEl = wl.querySelector("#wl-note");

  const setNote = (msg, kind) => {
    noteEl.textContent = msg;
    noteEl.className = "wl-note" + (kind ? " wl-note--" + kind : "");
  };
  const succeed = () => {
    form.outerHTML = '<p class="wl-ok">You’re on the list ✓ — we’ll email you when surfaces are live.</p>';
    noteEl.remove();
  };

  // Clicking "Want to advertise?" scrolls to the form (the anchor handles that)
  // and focuses its email field once the smooth-scroll settles.
  wl.querySelector(".wl-adv").addEventListener("click", () => {
    setTimeout(() => document.querySelector('.adform input[name="email"]')?.focus({ preventScroll: true }), 600);
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const value = (email.value || "").trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)) {
      setNote("Enter a valid email address.", "err");
      email.focus();
      return;
    }
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = "Joining…";
    // No API base (dev mode / misconfig): show success rather than hang.
    if (!API_BASE) { succeed(); return; }
    try {
      const res = await fetch(`${API_BASE}/v1/waitlist`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: value, source: waitlistSource() }),
      });
      if (res.ok) { succeed(); return; }
      if (res.status === 429) {
        setNote("Too many signups from here today — try again later.", "err");
      } else {
        const data = await res.json().catch(() => ({}));
        setNote(data.error ? cap(data.error) : "Something went wrong — try again.", "err");
      }
    } catch (_) {
      setNote("Couldn’t reach the server — check your connection and try again.", "err");
    }
    btn.disabled = false;
    btn.textContent = label;
  });
}
initWaitlist();

// --- Surfaces showcase: provider-tab cross-fade ("Native everywhere it
// appears"). Clicking a tab swaps the active screenshot within that surface
// row only. Scoped to .surfaces so it can't touch anything else on the page. ---
document.querySelectorAll(".surfaces .tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    const key = tab.dataset.shot;
    const scope = tab.closest(".surface");
    if (!scope) return;
    scope.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.shot === key));
    scope.querySelectorAll(".shot").forEach((s) => s.classList.toggle("active", s.dataset.shot === key));
  });
});
