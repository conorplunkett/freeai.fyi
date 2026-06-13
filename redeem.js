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
  $("redeem-view").hidden = false;
  $("referrals-view").hidden = true;
  $("nav-redeem").classList.add("active");
  $("nav-referrals").classList.remove("active");
}
function showReferralsView() {
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
  $("ref-count").textContent = `${body.rewardedCount || 0}/${body.cap}`;
  $("ref-pending").textContent = body.pendingCount || 0;
  renderReferralList(body.referrals || []);
}

function renderReferralList(items) {
  const el = $("ref-list");
  if (!items.length) {
    el.innerHTML = `<p class="ref-empty">No referrals yet — share your link to get started.</p>`;
    return;
  }
  const label = {
    pending: "Waiting on their first redemption",
    rewarded: "Rewarded",
    capped: "Cap reached — not credited",
    cancelled: "Cancelled",
  };
  el.innerHTML = items
    .map((r) => {
      const when = r.createdAt ? new Date(r.createdAt).toLocaleDateString() : "";
      return (
        `<div class="ref-item">` +
        `<span class="ref-badge ${r.status}">${r.status}</span>` +
        `<span class="ref-desc">${label[r.status] || r.status}</span>` +
        `<span class="ref-when">${when}</span>` +
        `</div>`
      );
    })
    .join("");
}

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
  $("auth-step-email").hidden    = step !== "email";
  $("auth-step-sent").hidden     = step !== "sent";
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
$("apple-btn").addEventListener("click", (e) => {
  e.preventDefault();
  if (!API_BASE) return showError("Sign-in is unavailable right now.");
  window.location.href = oauthUrl("apple");
});

// ── "Continue with email" ──
$("email-opt-btn").addEventListener("click", () => showStep("email"));

// ── "← back" from email step ──
$("back-to-providers").addEventListener("click", () => showStep("providers"));

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
  if (!lastEmail) { showStep("email"); return; }
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
$("back-btn").addEventListener("click", () => showStep("email"));

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
  const cat = await apiGet("/v1/giftcards");
  if (cat.status === 200) { catalog = cat.body; renderMenu(); updateSummary(); }
}
boot();
