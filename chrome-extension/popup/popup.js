// FreeAI.fyi — popup logic (Fuel Ring)
const $ = (id) => document.getElementById(id);
const setText = (id, val) => { const el = $(id); if (el) el.textContent = val; };
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// A free month of Claude Pro = $20 (the entry redemption — see giftcards.js). The
// fuel ring tracks credits earned toward that next free month, so progress stays
// meaningful at real balances. (The design mock framed the ring around a $200
// Claude Max month; we use the achievable Pro goal here — see the redesign notes.)
const MONTH_TARGET = 20;

// Ring geometry — must match the <svg> in popup.html (r=69, stroke=14).
const RING_R = 69;
const RING_C = 2 * Math.PI * RING_R;

function send(msg) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(msg, (resp) => {
        void chrome.runtime.lastError;
        resolve(resp);
      });
    } catch (_) {
      resolve(null);
    }
  });
}

const money = (n) => "$" + (n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function setRing(pct) {
  const arc = $("ring-arc");
  if (!arc) return;
  const clamped = Math.max(0, Math.min(1, pct));
  arc.setAttribute("stroke-dasharray", RING_C.toFixed(1));
  arc.setAttribute("stroke-dashoffset", (RING_C * (1 - clamped)).toFixed(1));
}

async function refresh() {
  const s = (await send({ type: "BB_GET_STATE" })) || {};
  const earnings = s.earnings || 0;

  // Hero ring — credits earned, and progress toward the next free month.
  setText("earnings", money(earnings));
  setText("goal", "of $" + MONTH_TARGET);
  const pct = earnings / MONTH_TARGET;
  setRing(pct);
  const progress = $("progress");
  if (progress) {
    const whole = Math.min(100, Math.round(pct * 100));
    progress.innerHTML = whole >= 100
      ? "<b>Ready</b> — redeem a free month of Claude"
      : `<b>${whole}%</b> toward a free month of Claude`;
  }

  // Stats
  setText("impressions", (s.impressions || 0).toLocaleString());
  setText("clicks", (s.clicks || 0).toLocaleString());
  $("enabled").checked = s.enabled !== false;
  const days = Math.max(1, Math.round((Date.now() - (s.installedAt || Date.now())) / 86400000));
  setText("perday", money(earnings / days));

  // Live status line reflects the on/off switch.
  const status = $("status");
  if (status) {
    const on = s.enabled !== false;
    status.classList.toggle("off", !on);
    status.querySelector(".status-txt").innerHTML = on
      ? "Active on <b>chatgpt.com</b>, <b>claude.ai</b>"
      : "Paused — flip the switch to start earning";
  }

  // Test mode (developer tools)
  const on = !!s.testMode;
  if ($("testmode")) $("testmode").checked = on;
  if ($("test-pill")) $("test-pill").hidden = !on;
  if ($("test-hint")) $("test-hint").hidden = !on;
  if (on) {
    setText("test-counts", `${s.testImpressions || 0} mock impressions · ${s.testClicks || 0} mock clicks (not billed).`);
  }
}

// CREW — the affiliate "earn with your friends" panel. The extension stays
// anonymous: until the device is linked to an account it shows the sign-in CTA;
// once linked (device-scoped /v1/me/affiliate via the background) it shows each
// friend, what they've generated, and your 10% cut — which accrues forever.
let inviteLink = null; // the user's affiliate link, set once linked

function friendRow(f) {
  const cut = `<div class="cut"><div class="v">+${esc(money(f.youUsd || 0))}</div><div class="k">your 10%</div></div>`;
  return (
    `<div class="friend">` +
    `<div class="meta">` +
    `<div class="nm">${esc(f.name || "a friend")}</div>` +
    `<div class="sub">generated <b>${esc(money(f.generatedUsd || 0))}</b> in credits</div>` +
    `</div>${cut}</div>`
  );
}

async function refreshCrew() {
  const crew = (await send({ type: "BB_GET_CREW" })) || {};
  const list = $("crew-list");
  const sum = $("crew-sum");
  const signedout = $("crew-signedout");
  const invite = $("invite");
  const linked = crew.linked === true;
  const friends = Array.isArray(crew.friends) ? crew.friends : [];

  if (signedout) signedout.hidden = linked;
  if (invite) invite.hidden = !linked;

  if (!linked) {
    setText("crew-label", "Your crew");
    if (list) list.innerHTML = "";
    if (sum) sum.hidden = true;
    inviteLink = null;
    return;
  }

  inviteLink = crew.link || null;
  setText("crew-label", friends.length
    ? `Your crew · ${friends.length} ${friends.length === 1 ? "friend" : "friends"}`
    : "Your crew");
  if (list) {
    list.innerHTML = friends.length
      ? friends.map(friendRow).join("")
      : `<p class="crew-empty">No friends yet — share your link and earn <b>10%</b> of their credits, forever.</p>`;
  }
  if (sum) {
    if (crew.creditedUsd > 0) {
      sum.textContent = `+${money(crew.creditedUsd)} to you`;
      sum.hidden = false;
    } else {
      sum.hidden = true;
    }
  }
}

// Sign-in: reveal the email field, then email a magic link that links this device
// to an account (background → POST /v1/auth/request-link).
if ($("signin-btn")) {
  $("signin-btn").addEventListener("click", () => {
    $("signin-btn").hidden = true;
    $("signin-form").hidden = false;
    $("signin-email").focus();
  });
}
if ($("signin-form")) {
  $("signin-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = $("signin-email").value.trim();
    const msg = $("signin-msg");
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      msg.hidden = false; msg.textContent = "Enter a valid email address."; return;
    }
    $("signin-send").disabled = true;
    const r = (await send({ type: "BB_SIGNIN", email })) || {};
    $("signin-send").disabled = false;
    msg.hidden = false;
    msg.innerHTML = r.ok
      ? `Check <b>${esc(email)}</b> — click the link to start earning with friends.`
      : esc(r.error || "Couldn't send the link. Try again.");
    if (r.ok) { $("signin-form").hidden = true; }
  });
}

// Invite (linked): copy the affiliate link; fall back to opening it.
if ($("invite")) {
  $("invite").addEventListener("click", async () => {
    if (!inviteLink) return;
    try {
      await navigator.clipboard.writeText(inviteLink);
      const el = $("invite");
      const prev = el.innerHTML;
      el.innerHTML = `<span class="plus">✓</span>Link copied — share it to start earning`;
      setTimeout(() => { el.innerHTML = prev; }, 2200);
    } catch (_) {
      window.open(inviteLink, "_blank", "noopener");
    }
  });
}

// Top-5 of the live bid market.
function boardHtml(ads) {
  return ads
    .slice(0, 5)
    .map(
      (a, i) =>
        `<li><span class="rk">${i + 1}</span>` +
        `<span class="chip" style="background:${esc(a.color)};color:${esc(a.ink)}">${esc(a.chip)}</span>` +
        `<span class="ln"><b>${esc(a.brand)}</b> — ${esc(a.line)}</span></li>`
    )
    .join("");
}
function renderBoard() {
  $("board").innerHTML = boardHtml(self.BB_ADS || []);
}
// Pull live inventory from the background (auction-backed) so the board mirrors
// what the injected bar would actually show; fall back to the bundled list.
async function refreshBoard() {
  const ads = await send({ type: "BB_GET_ADS" });
  if (Array.isArray(ads) && ads.length) $("board").innerHTML = boardHtml(ads);
}

$("enabled").addEventListener("change", async (e) => {
  await send({ type: "BB_SET", payload: { enabled: e.target.checked } });
  refresh();
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab) chrome.tabs.sendMessage(tab.id, { type: "BB_REFRESH" }, () => void chrome.runtime.lastError);
});

if ($("testmode")) {
  $("testmode").addEventListener("change", async (e) => {
    await send({ type: "BB_SET", payload: { testMode: e.target.checked } });
    await refresh();
    // push the change to the active tab so the mock ad appears/disappears now
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab) {
      chrome.tabs.sendMessage(tab.id, { type: "BB_REFRESH" }, () => {
        if (chrome.runtime.lastError) {
          $("test-hint").hidden = false;
          setText("test-counts", "Open chatgpt.com / claude.ai / gemini.google.com, then reload the tab to see the mock ad.");
        }
      });
    }
  });
}

if ($("demo")) {
  $("demo").addEventListener("click", async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) return;
    chrome.tabs.sendMessage(tab.id, { type: "BB_DEMO", ms: 30000 }, () => {
      if (chrome.runtime.lastError) {
        setText("hint", "Open a supported AI site (claude.ai, chatgpt.com…) and try the demo there.");
      } else {
        setText("hint", "Demo running on the active tab — watch the sponsored line for 30s.");
      }
    });
  });
}

if ($("reset")) {
  $("reset").addEventListener("click", async () => {
    await send({ type: "BB_RESET" });
    refresh();
  });
}

renderBoard();   // instant paint from the bundled list
refreshBoard();  // then swap in live inventory if available
refresh();
refreshCrew();
setInterval(refresh, 1000);
// Slower poll so the crew panel flips from signed-out → linked once the user
// clicks the magic link in their email (no network spam on the 1s tick).
setInterval(refreshCrew, 8000);
