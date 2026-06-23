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
  $("enabled").checked = s.enabled !== false;
  const days = Math.max(1, Math.round((Date.now() - (s.installedAt || Date.now())) / 86400000));
  setText("perday", money(earnings / days));

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
// anonymous: until the device is linked to an account it shows the sign-in CTA
// (which opens the freeai.fyi login page); once linked (device-scoped
// /v1/me/affiliate via the background) it shows up to 5 slots — each a joined
// friend (with their generated credits + your 10% cut, forever), a pending
// invite, or an open invite form to add the next friend.
const CREW_SIZE = 5;

// A joined friend: what they've generated and the 10% it earned you.
function friendSlot(f) {
  const cut = `<div class="cut"><div class="v">+${esc(money(f.youUsd || 0))}</div><div class="k">your 10%</div></div>`;
  return (
    `<div class="friend">` +
    `<div class="meta">` +
    `<div class="nm">${esc(f.name || "a friend")}</div>` +
    `<div class="sub">generated <b>${esc(money(f.generatedUsd || 0))}</b> in credits</div>` +
    `</div>${cut}</div>`
  );
}

// A sent-but-not-yet-joined invite (email is masked server-side).
function invitedSlot(inv) {
  return (
    `<div class="friend invited">` +
    `<div class="meta"><div class="nm">${esc(inv.email || "a friend")}</div></div>` +
    `<div class="badge">Invited</div></div>`
  );
}

// The single active invite form, shown in the first open slot. The "N slots
// open" label sits above the form as a small header for the open section.
function formSlot(open) {
  const left = open === 1 ? "1 slot open" : `${open} slots open`;
  return (
    `<p class="invite-hint" id="invite-hint">${left}</p>` +
    `<form class="invite-form" id="invite-form">` +
    `<input type="email" id="invite-email" placeholder="friend@email.com" autocomplete="off" spellcheck="false" />` +
    `<button type="submit" id="invite-send">Invite</button>` +
    `</form>` +
    `<p class="invite-msg" id="invite-msg" hidden></p>`
  );
}

// Muted placeholder for any remaining open slots beyond the active form.
function emptySlot() {
  return `<div class="slot-empty"><span class="slot-dot">+</span>Open slot</div>`;
}

function renderCrewSlots(friends, invited, size) {
  const wrap = $("crew-slots");
  if (!wrap) return;
  const rows = [];
  let used = 0;
  for (const f of friends) { if (used >= size) break; rows.push(friendSlot(f)); used++; }
  for (const inv of invited) { if (used >= size) break; rows.push(invitedSlot(inv)); used++; }
  const open = Math.max(0, size - used);
  if (open > 0) {
    rows.push(formSlot(open));
    for (let i = 1; i < open; i++) rows.push(emptySlot());
  } else {
    rows.push(`<p class="crew-full">Crew full — all ${size} slots taken 🎉</p>`);
  }
  wrap.innerHTML = rows.join("");
  bindInviteForm();
}

function bindInviteForm() {
  const form = $("invite-form");
  if (!form) return;
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const input = $("invite-email");
    const btn = $("invite-send");
    const msg = $("invite-msg");
    const email = (input && input.value || "").trim();
    if (!email) return;
    if (btn) { btn.disabled = true; btn.textContent = "Sending…"; }
    const r = (await send({ type: "BB_INVITE", email })) || {};
    if (r.ok) {
      // The new pending invite repaints as its own slot on the refresh below; the
      // fresh form lands in the next open slot, ready for another friend.
      crewSig = null;
      await refreshCrew();
    } else {
      if (btn) { btn.disabled = false; btn.textContent = "Invite"; }
      if (msg) { msg.hidden = false; msg.className = "invite-msg err"; msg.textContent = r.error || "Couldn't send — try again"; }
    }
  });
}

// Paint a crew object onto the panel. Re-renders the slots only when the crew
// actually changes, so an 8s poll never wipes an email the user is mid-type.
let crewSig = null;
function applyCrew(crew) {
  crew = crew || {};
  const sum = $("crew-sum");
  const signedout = $("crew-signedout");
  const linkedWrap = $("crew-linked");
  const linked = crew.linked === true;

  if (signedout) signedout.hidden = linked;
  if (linkedWrap) linkedWrap.hidden = !linked;

  if (!linked) {
    setText("crew-label", "Your crew");
    if (sum) sum.hidden = true;
    crewSig = null;
    return;
  }

  const friends = Array.isArray(crew.friends) ? crew.friends : [];
  const invited = Array.isArray(crew.invited) ? crew.invited : [];
  const size = crew.crewSize || CREW_SIZE;
  if (crew.rewardPct && $("crew-pct")) setText("crew-pct", Math.round(crew.rewardPct) + "%");

  const filled = Math.min(friends.length + invited.length, size);
  setText("crew-label", `Your crew · ${filled} of ${size}`);
  if (sum) {
    if (crew.creditedUsd > 0) {
      sum.textContent = `+${money(crew.creditedUsd)} to you`;
      sum.hidden = false;
    } else {
      sum.hidden = true;
    }
  }

  const sig = JSON.stringify({ friends, invited, size });
  if (sig === crewSig) return;
  crewSig = sig;
  renderCrewSlots(friends, invited, size);
}

async function refreshCrew() {
  applyCrew((await send({ type: "BB_GET_CREW" })) || {});
}

// Instant first paint from the last crew we saw (cached by the background on
// every fetch), so the panel never flashes the sign-in CTA or an empty list
// before the network responds.
async function primeCrewFromCache() {
  try {
    const { crewCache } = await chrome.storage.local.get(["crewCache"]);
    if (crewCache) applyCrew(crewCache);
  } catch (_) {}
}

// Sign-in: open the freeai.fyi login page in a new tab. No magic link in the
// extension — once the user signs in there, the device auto-links and the crew
// panel flips to linked on the next poll.
if ($("signin-btn")) {
  $("signin-btn").addEventListener("click", () => {
    chrome.tabs.create({ url: "https://freeai.fyi/redeem.html" });
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

if ($("reset")) {
  $("reset").addEventListener("click", async () => {
    await send({ type: "BB_RESET" });
    refresh();
  });
}

// The little Claude critter idles via CSS (bob + blink + twinkle); give the one
// on the redeem button an occasional hop so he feels alive while the popup's open.
const ctaGuy = $("cta-claude-guy");
const reducedMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
if (ctaGuy && !reducedMotion) {
  const hop = () => {
    ctaGuy.classList.add("cg-hop");
    setTimeout(() => ctaGuy.classList.remove("cg-hop"), 600);
    setTimeout(hop, 3200 + Math.random() * 3600);
  };
  setTimeout(hop, 2600);
}

renderBoard();   // instant paint from the bundled list
refreshBoard();  // then swap in live inventory if available
refresh();
primeCrewFromCache().then(refreshCrew); // cached crew first (no flash), then live
setInterval(refresh, 1000);
// Slower poll so the crew panel flips from signed-out → linked once the user
// clicks the magic link in their email (no network spam on the 1s tick).
setInterval(refreshCrew, 8000);
