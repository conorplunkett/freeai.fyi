// FreeAI.fyi — website redemption flow. Email magic-link or OAuth sign-in,
// then read the server-side balance and redeem for a Claude gift card.

const API_BASE = (
  window.FREEAI_API ||
  document.querySelector('meta[name="freeai-api"]')?.content ||
  ""
).replace(/\/+$/, "");

const SESSION_KEY = "freeai_session";
const $ = (id) => document.getElementById(id);
const usd = (n) => "$" + Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const usdWhole = (n) => "$" + Number(n).toLocaleString(undefined, { maximumFractionDigits: 0 });

// Session token from OAuth or magic-link arrives in URL fragment; stash and scrub.
(function captureSession() {
  const m = location.hash.match(/session=([^&]+)/);
  if (m) {
    localStorage.setItem(SESSION_KEY, decodeURIComponent(m[1]));
    history.replaceState(null, "", location.pathname);
  }
})();

// Show OAuth error from ?login= query param, then clean URL.
(function captureOAuthError() {
  const params = new URLSearchParams(location.search);
  const login = params.get("login");
  if (!login) return;
  history.replaceState(null, "", location.pathname);
  const msgs = {
    cancelled: "Sign-in was cancelled. Try again.",
    error:     "Something went wrong with sign-in. Try again or use email.",
    "no-google": "Google sign-in is not configured. Use email instead.",
    "no-apple":  "Apple sign-in is not configured. Use email instead.",
    expired:     "That sign-in link expired. Request a new one.",
  };
  showError(msgs[login] || "Sign-in failed. Try again.");
})();

// Referral code from ?ref= (shared link). Stash it, prefill the field, scrub URL.
let referralCode = "";
(function captureRef() {
  const ref = new URLSearchParams(location.search).get("ref");
  if (!ref) return;
  referralCode = ref.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 16);
  history.replaceState(null, "", location.pathname);
})();

// Current referral code: whatever's typed in the field, else the captured one.
function getReferralCode() {
  const v = ($("referral-code")?.value || "").trim();
  return v.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 16);
}

const getSession = () => localStorage.getItem(SESSION_KEY);

async function apiGet(path) {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${getSession()}` },
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
async function apiPost(path, payload) {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${getSession()}` },
    body: JSON.stringify(payload || {}),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

// ---- page views ----
function showLoginPage() {
  $("login-page").hidden = false;
  $("redeem-page").hidden = true;
}
function showRedeemPage(email) {
  $("login-page").hidden = true;
  $("redeem-page").hidden = false;
  $("balance-email").textContent = email;
  if (!$("recipient").value) $("recipient").value = email;
  showRedeemView();
}

// ---- authed sub-views: Redeem vs Referrals ----
function showRedeemView() {
  $("earnings-view").hidden = false;
  $("activity-view").hidden = false;
  $("redeem-view").hidden = false;
  $("referrals-view").hidden = true;
  $("nav-redeem").classList.add("active");
  $("nav-referrals").classList.remove("active");
}
function showReferralsView() {
  $("earnings-view").hidden = true;
  $("activity-view").hidden = true;
  $("redeem-view").hidden = true;
  $("referrals-view").hidden = false;
  $("nav-redeem").classList.remove("active");
  $("nav-referrals").classList.add("active");
  loadReferrals();
}
$("nav-redeem").addEventListener("click", showRedeemView);
$("nav-referrals").addEventListener("click", showReferralsView);

async function loadReferrals() {
  const { status, body } = await apiGet("/v1/web/referrals");
  if (status === 401) { localStorage.removeItem(SESSION_KEY); location.reload(); return; }
  if (status !== 200) return;
  $("ref-link").value = body.link || "";
  $("ref-earned").textContent = usd(body.creditsEarnedUsd || 0);
  $("ref-earned-2").textContent = usd(body.creditsEarnedUsd || 0);
  $("ref-reward").textContent = usdWhole(body.rewardUsd || 20);
  $("ref-reward-2").textContent = usdWhole(body.rewardUsd || 20);
  $("ref-cap").textContent = body.cap;
  $("ref-invited").textContent = body.invitedCount || 0;
  $("ref-count").textContent = `${body.rewardedCount || 0}/${body.cap}`;
  $("ref-pending").textContent = body.pendingCount || 0;
  renderReferralList(body.referrals || []);
}

// One row per friend, ordered newest-first, walking the full referral journey:
// invited (email sent) → pending (signed up with the code) → rewarded, plus the
// terminal capped / cancelled states. The status badge is the stage indicator
// and the email is the "who you referred" the dashboard surfaces.
function renderReferralList(items) {
  const el = $("ref-list");
  if (!items.length) {
    el.innerHTML = `<p class="ref-empty">No referrals yet — invite a friend or share your link to get started.</p>`;
    return;
  }
  const label = {
    invited: "Invite sent — waiting for them to sign up",
    pending: "Signed up — waiting on their first redemption",
    rewarded: "Rewarded",
    capped: "Cap reached — not credited",
    cancelled: "Cancelled",
  };
  el.innerHTML = items
    .map((r) => {
      const when = r.createdAt ? new Date(r.createdAt).toLocaleDateString() : "";
      const who = r.email ? escapeHtml(r.email) : (label[r.status] || r.status);
      return (
        `<div class="ref-item">` +
        `<span class="ref-badge ${r.status}">${r.status}</span>` +
        `<span class="ref-desc"><strong>${who}</strong><span class="ref-sub">${label[r.status] || r.status}</span></span>` +
        `<span class="ref-when">${when}</span>` +
        `</div>`
      );
    })
    .join("");
}

// Send a referral invite to a friend's email. The backend rejects the user's own
// address; we surface that (and any other error) inline under the form.
function setInviteMsg(text, kind) {
  const el = $("ref-invite-msg");
  el.textContent = text || "";
  el.hidden = !text;
  el.className = "ref-invite-msg" + (kind ? ` ${kind}` : "");
}

$("ref-invite-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = ($("ref-invite-email").value || "").trim();
  if (!email) return;
  const btn = $("ref-invite-btn");
  btn.disabled = true;
  setInviteMsg("Sending…", "");
  const { status, body } = await apiPost("/v1/web/referrals/invite", { email });
  btn.disabled = false;
  if (status === 401) { localStorage.removeItem(SESSION_KEY); location.reload(); return; }
  if (status === 200) {
    setInviteMsg(`Invite sent to ${email}.`, "ok");
    $("ref-invite-email").value = "";
    loadReferrals();
  } else {
    setInviteMsg((body && body.error) || "Couldn't send that invite. Try again.", "err");
  }
});

$("ref-copy").addEventListener("click", async () => {
  const link = $("ref-link").value;
  if (!link) return;
  try {
    await navigator.clipboard.writeText(link);
  } catch {
    $("ref-link").select();
    try { document.execCommand("copy"); } catch {}
  }
  const btn = $("ref-copy");
  const old = btn.textContent;
  btn.textContent = "Copied!";
  setTimeout(() => (btn.textContent = old), 1500);
});

// ---- auth card steps ----
function showError(msg) {
  const el = $("auth-error");
  el.textContent = msg;
  el.hidden = !msg;
}
function showStep(step) {
  $("auth-step-providers").hidden = step !== "providers";
  $("auth-step-sent").hidden      = step !== "sent";
  if (step !== "sent") showError("");
}

// ── OAuth provider buttons ──
function oauthUrl(provider) {
  const ref = getReferralCode();
  return `${API_BASE}/v1/auth/${provider}${ref ? `?ref=${encodeURIComponent(ref)}` : ""}`;
}
$("google-btn").addEventListener("click", (e) => {
  e.preventDefault();
  if (!API_BASE) return showError("Sign-in is unavailable right now.");
  window.location.href = oauthUrl("google");
});

// ── Send magic link ──
let lastEmail = "";

async function requestLink(email) {
  if (!API_BASE) { showError("Sign-in is unavailable right now."); return false; }
  const { status } = await apiPost("/v1/web/login", { email, referralCode: getReferralCode() });
  return status === 200;
}

$("login-btn").addEventListener("click", async () => {
  const email = $("login-email").value.trim();
  if (!email) return;
  lastEmail = email;
  $("login-btn").disabled = true;
  $("login-btn").textContent = "Sending…";
  const ok = await requestLink(email);
  $("login-btn").disabled = false;
  $("login-btn").textContent = "Email me a sign-in link";
  if (ok) {
    $("auth-sent-msg").textContent =
      `We sent a sign-in link to ${email}. Check your inbox — it expires in 30 minutes.`;
    showStep("sent");
  } else {
    showError("That didn't work. Double-check your email and try again.");
  }
});

$("login-email").addEventListener("keydown", (e) => {
  if (e.key === "Enter") $("login-btn").click();
});

// ── Resend (both buttons) ──
async function handleResend(btn) {
  if (!lastEmail) { showStep("providers"); return; }
  btn.disabled = true;
  btn.textContent = "Sending…";
  await requestLink(lastEmail);
  btn.disabled = false;
  btn.textContent = "Resend sign-in email";
  $("auth-sent-msg").textContent =
    `Resent to ${lastEmail}. Check your inbox — it expires in 30 minutes.`;
}
$("resend-btn").addEventListener("click", () => handleResend($("resend-btn")));
$("resend-btn-2").addEventListener("click", () => handleResend($("resend-btn-2")));

// ── "← back" from sent step ──
$("back-btn").addEventListener("click", () => showStep("providers"));

// ── Sign out ──
$("signout").addEventListener("click", () => {
  localStorage.removeItem(SESSION_KEY);
  location.reload();
});

// ---- state ----
let balanceUsd = 0;
let catalog = null;
let selected = null;

// ---- gift menu ----
function renderMenu() {
  if (!catalog) return;
  const menu = $("gift-menu");
  menu.innerHTML = catalog.plans
    .map((p) => {
      const cells = catalog.months
        .map((m) => {
          const price = p.monthlyUsd * m;
          const afford = balanceUsd >= price;
          const isSel = selected && selected.plan === p.id && selected.months === m;
          return (
            `<button class="gift-cell${isSel ? " sel" : ""}" ` +
            `data-plan="${p.id}" data-months="${m}" data-price="${price}" data-name="${p.name}" ` +
            `${afford ? "" : "disabled"}>` +
            `<span class="gc-term">${m} mo</span>` +
            `<span class="gc-price">${usdWhole(price)}</span>` +
            `</button>`
          );
        })
        .join("");
      return (
        `<div class="gift-row">` +
        `<div class="gift-plan"><span class="gp-name">${p.name}</span>` +
        `<span class="gp-tag">${p.tagline} · ${usdWhole(p.monthlyUsd)}/mo</span></div>` +
        `<div class="gift-cells">${cells}</div>` +
        `</div>`
      );
    })
    .join("");
  menu.querySelectorAll(".gift-cell:not([disabled])").forEach((btn) => {
    btn.addEventListener("click", () => {
      selected = {
        plan: btn.dataset.plan,
        months: parseInt(btn.dataset.months, 10),
        amountUsd: parseFloat(btn.dataset.price),
        planName: btn.dataset.name,
      };
      renderMenu();
      updateSummary();
    });
  });
}

function updateSummary() {
  const btn = $("redeem-btn");
  if (!selected) {
    $("summary").textContent = "Select a gift above to continue.";
    btn.disabled = true;
    return;
  }
  const termLabel = `${selected.months} month${selected.months > 1 ? "s" : ""}`;
  $("summary").innerHTML =
    `<strong>${selected.planName}</strong> · ${termLabel} · ${usd(selected.amountUsd)} ` +
    `<span class="sum-after">→ ${usd(balanceUsd - selected.amountUsd)} left</span>`;
  btn.disabled = false;
}

// ---- redeem ----
$("redeem-btn").addEventListener("click", async () => {
  if (!selected) return;
  const recipientEmail = $("recipient").value.trim();
  const btn = $("redeem-btn");
  btn.disabled = true;
  const old = btn.textContent;
  btn.textContent = "Redeeming…";
  const { status, body } = await apiPost("/v1/web/redemptions", {
    plan: selected.plan, months: selected.months, recipientEmail,
  });
  btn.textContent = old;
  const result = $("redeem-result");
  result.hidden = false;
  if (status === 200) {
    result.className = "redeem-result ok";
    result.innerHTML =
      `Done. Your <strong>${selected.planName}</strong> gift card ` +
      `(${selected.months} month${selected.months > 1 ? "s" : ""}) ` +
      `is on its way to <strong>${recipientEmail}</strong> within <strong>48 hours</strong>.`;
    balanceUsd = body.balanceUsd;
    selected = null;
    $("balance").textContent = usd(balanceUsd);
    renderMenu();
    updateSummary();
  } else if (status === 401) {
    localStorage.removeItem(SESSION_KEY);
    location.reload();
  } else {
    result.className = "redeem-result err";
    result.textContent = body.error === "insufficient credits"
      ? `You need ${usd(body.requiredUsd)} but have ${usd(body.balanceUsd)}.`
      : (body.error || "Something went wrong. Try again.");
    btn.disabled = false;
  }
});

// ---- earnings dashboard ----
let earnWindow = "7d";

async function loadEarnings(window = earnWindow) {
  earnWindow = window;
  const { status, body } = await apiGet(`/v1/web/earnings?window=${window}`);
  if (status === 401) { localStorage.removeItem(SESSION_KEY); location.reload(); return; }
  if (status !== 200) return;
  $("earn-today").textContent = usd(body.todayUsd || 0);
  $("earn-month").textContent = usd(body.monthUsd || 0);
  $("earn-lifetime").textContent = usd(body.lifetimeUsd || 0);
  renderChart(body.series || [], window);
}

// Snap a Date to the start of its hour/day bucket (local time) for axis fill.
function bucketStart(d, unit) {
  const x = new Date(d);
  x.setMinutes(0, 0, 0);
  if (unit === "day") x.setHours(0, 0, 0, 0);
  return x;
}

// Build a continuous, gap-filled axis from the sparse server series so the
// chart shows zero-credit periods too (mirrors the activity chart in the spec).
function fillSeries(series, window) {
  const unit = window === "24h" ? "hour" : "day";
  const points = window === "24h" ? 24 : window === "7d" ? 7 : 30;
  const stepMs = unit === "hour" ? 3600e3 : 86400e3;
  const byKey = new Map();
  for (const b of series) byKey.set(bucketStart(b.t, unit).getTime(), b);
  const end = bucketStart(Date.now(), unit).getTime();
  const out = [];
  for (let i = points - 1; i >= 0; i--) {
    const t = end - i * stepMs;
    const hit = byKey.get(t);
    out.push({ t: new Date(t), usd: hit ? hit.usd : 0, count: hit ? hit.count : 0 });
  }
  return out;
}

function renderChart(series, window) {
  const host = $("earn-chart");
  const pts = fillSeries(series, window);
  const totalUsd = pts.reduce((s, p) => s + p.usd, 0);
  const totalEvents = pts.reduce((s, p) => s + p.count, 0);
  $("earn-chart-foot").textContent =
    `${usd(totalUsd)} across ${totalEvents.toLocaleString()} event${totalEvents === 1 ? "" : "s"}`;

  const W = 720, H = 220, padL = 8, padR = 8, padT = 14, padB = 26;
  const innerW = W - padL - padR, innerH = H - padT - padB;
  const max = Math.max(...pts.map((p) => p.usd), 0);
  const baseY = padT + innerH;
  const xAt = (i) => padL + (pts.length === 1 ? innerW / 2 : (i / (pts.length - 1)) * innerW);
  const yAt = (v) => (max <= 0 ? baseY : baseY - (v / max) * innerH);

  // baseline grid + faint horizontal rules
  const grid = [0, 0.5, 1].map((f) => {
    const y = padT + innerH - f * innerH;
    return `<line x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" class="ec-grid" />`;
  }).join("");

  const linePts = pts.map((p, i) => `${xAt(i).toFixed(1)},${yAt(p.usd).toFixed(1)}`).join(" ");
  const areaPts = `${padL},${baseY} ${linePts} ${(W - padR)},${baseY}`;

  // sparse x labels: ~every Nth bucket
  const labelEvery = Math.ceil(pts.length / 8);
  const labels = pts.map((p, i) => {
    if (i % labelEvery !== 0 && i !== pts.length - 1) return "";
    const txt = window === "24h"
      ? p.t.toLocaleTimeString(undefined, { hour: "numeric" })
      : p.t.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    return `<text x="${xAt(i).toFixed(1)}" y="${H - 8}" class="ec-xlabel">${txt}</text>`;
  }).join("");

  const dots = max > 0
    ? pts.map((p, i) => p.usd > 0
        ? `<circle cx="${xAt(i).toFixed(1)}" cy="${yAt(p.usd).toFixed(1)}" r="2.6" class="ec-dot" />`
        : "").join("")
    : "";

  host.innerHTML =
    `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" class="ec-svg" role="img" aria-label="Earnings over time">` +
    grid +
    `<polygon points="${areaPts}" class="ec-area" />` +
    `<polyline points="${linePts}" class="ec-line" />` +
    dots + labels +
    `</svg>`;
}

$("earn-window").addEventListener("click", (e) => {
  const btn = e.target.closest(".ew-btn");
  if (!btn) return;
  $("earn-window").querySelectorAll(".ew-btn").forEach((b) => b.classList.remove("active"));
  btn.classList.add("active");
  loadEarnings(btn.dataset.window);
});

// ---- activity ledger ----
let activityRows = null;

const ACT_LABEL = {
  impression_credit: "Impression",
  click_credit: "Click",
  referral_credit: "Referral bonus",
};

async function retrieveActivity() {
  const btn = $("act-retrieve");
  if (btn) { btn.disabled = true; btn.textContent = "Retrieving…"; }
  const { status, body } = await apiGet("/v1/web/activity?limit=200");
  if (status === 401) { localStorage.removeItem(SESSION_KEY); location.reload(); return; }
  if (status !== 200) {
    if (btn) { btn.disabled = false; btn.textContent = "Retrieve activity"; }
    return;
  }
  activityRows = body.rows || [];
  $("act-status").textContent = "Retrieved";
  $("act-status").classList.add("ok");
  $("act-search").disabled = false;
  $("act-filter").disabled = false;
  renderActivity();
}

function filteredActivity() {
  if (!activityRows) return [];
  const q = ($("act-search").value || "").trim().toLowerCase();
  const type = $("act-filter").value;
  return activityRows.filter((r) => {
    if (type !== "all" && r.type !== type) return false;
    if (!q) return true;
    const hay = `${r.advertiser || ""} ${r.id} ${r.type} ${ACT_LABEL[r.type] || ""}`.toLowerCase();
    return hay.includes(q);
  });
}

function renderActivity() {
  const body = $("act-body");
  const rows = filteredActivity();
  $("act-count").textContent = `${rows.length} of ${activityRows.length} rows`;

  if (!activityRows.length) {
    body.innerHTML = `<div class="act-empty"><p>No credited events yet. Use the extension while you chat to start earning.</p></div>`;
    return;
  }
  if (!rows.length) {
    body.innerHTML = `<div class="act-empty"><p>No events match your search.</p></div>`;
    return;
  }

  const head =
    `<div class="act-row act-row-head">` +
    `<span>Event</span><span>Advertiser</span><span>When</span><span class="act-amt">Credit</span>` +
    `</div>`;
  const items = rows.map((r) => {
    const when = r.createdAt ? new Date(r.createdAt).toLocaleString() : "";
    const label = ACT_LABEL[r.type] || r.type;
    return (
      `<div class="act-row">` +
      `<span class="act-type ${r.type}">${label}</span>` +
      `<span class="act-adv">${r.advertiser ? escapeHtml(r.advertiser) : "—"}</span>` +
      `<span class="act-when">${when}</span>` +
      `<span class="act-amt">${usd(r.amountUsd)}</span>` +
      `</div>`
    );
  }).join("");
  body.innerHTML = head + items;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

$("act-retrieve")?.addEventListener("click", retrieveActivity);
$("act-search").addEventListener("input", renderActivity);
$("act-filter").addEventListener("change", renderActivity);

// ---- boot ----
async function boot() {
  showStep("providers"); // default card state
  // Prefill a referral code shared via ?ref= and surface it to the new user.
  if (referralCode) {
    if ($("referral-code")) $("referral-code").value = referralCode;
    const note = $("referral-note");
    if (note) {
      note.textContent = `🎁 Referral code ${referralCode} applied.`;
      note.hidden = false;
    }
  }
  if (!getSession() || !API_BASE) return showLoginPage();
  const me = await apiGet("/v1/web/me");
  if (me.status !== 200) return showLoginPage();
  balanceUsd = me.body.balanceUsd || 0;
  $("balance").textContent = usd(balanceUsd);
  showRedeemPage(me.body.email);
  loadEarnings("7d");
  const cat = await apiGet("/v1/giftcards");
  if (cat.status === 200) { catalog = cat.body; renderMenu(); updateSummary(); }
}
boot();
