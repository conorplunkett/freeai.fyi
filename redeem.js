// FreeAI.fyi — website redemption flow. This is the ONLY place users redeem
// credits for Claude gift cards (see AGENTS.md). Email magic-link sign-in, then
// read the server-side balance and redeem against it.

const API_BASE = (
  window.FREEAI_API ||
  document.querySelector('meta[name="freeai-api"]')?.content ||
  ""
).replace(/\/+$/, "");

const SESSION_KEY = "freeai_session";
const $ = (id) => document.getElementById(id);
const usd = (n) => "$" + Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const usdWhole = (n) => "$" + Number(n).toLocaleString(undefined, { maximumFractionDigits: 0 });

// Session token arrives in the URL fragment from /v1/web/session; stash it and
// scrub the URL so it isn't left in history.
(function captureSession() {
  const m = location.hash.match(/session=([^&]+)/);
  if (m) {
    localStorage.setItem(SESSION_KEY, decodeURIComponent(m[1]));
    history.replaceState(null, "", location.pathname);
  }
})();

const getSession = () => localStorage.getItem(SESSION_KEY);
async function apiGet(path) {
  const res = await fetch(`${API_BASE}${path}`, { headers: { Authorization: `Bearer ${getSession()}` } });
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

// ---- state ----
let balanceUsd = 0;
let catalog = null; // { plans:[{id,name,tagline,monthlyUsd}], months:[1,3,6,12] }
let selected = null; // { plan, months, amountUsd, planName }

// ---- views ----
function showLogin(msg) {
  $("login-view").hidden = false;
  $("redeem-view").hidden = true;
  $("signout").hidden = true;
  if (msg) { $("login-msg").hidden = false; $("login-msg").textContent = msg; }
}
function showRedeem(email) {
  $("login-view").hidden = true;
  $("redeem-view").hidden = false;
  $("signout").hidden = false;
  $("balance-email").textContent = email;
  if (!$("recipient").value) $("recipient").value = email;
}

// ---- login ----
$("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = $("login-email").value.trim();
  if (!email) return;
  if (!API_BASE) return showLogin("Sign-in is unavailable right now. Please try again later.");
  $("login-btn").disabled = true;
  const { status } = await apiPost("/v1/web/login", { email });
  $("login-btn").disabled = false;
  if (status === 200) {
    $("login-form").hidden = true;
    showLogin(`Check ${email} for a sign-in link. It expires in 30 minutes.`);
  } else {
    showLogin("That didn't work. Double-check your email and try again.");
  }
});

$("signout").addEventListener("click", (e) => {
  e.preventDefault();
  localStorage.removeItem(SESSION_KEY);
  location.reload();
});

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
      `Done. Your <strong>${selected.planName}</strong> gift card (${selected.months} month${selected.months > 1 ? "s" : ""}) ` +
      `is on its way to <strong>${recipientEmail}</strong> within <strong>48 hours</strong>.`;
    balanceUsd = body.balanceUsd;
    selected = null;
    $("balance").textContent = usd(balanceUsd);
    renderMenu();
    updateSummary();
  } else if (status === 401) {
    showLogin("Your session expired. Sign in again to redeem.");
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
  if (!getSession() || !API_BASE) return showLogin();
  const me = await apiGet("/v1/web/me");
  if (me.status !== 200) return showLogin();
  balanceUsd = me.body.balanceUsd || 0;
  $("balance").textContent = usd(balanceUsd);
  showRedeem(me.body.email);
  const cat = await apiGet("/v1/giftcards");
  if (cat.status === 200) { catalog = cat.body; renderMenu(); updateSummary(); }
}
boot();
