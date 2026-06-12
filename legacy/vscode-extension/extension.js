// FreeAI.fyi — VS Code extension
// Turns the Claude Code / Codex loading spinner into a tiny ad marketplace.
// You keep 90% of the revenue.
//
// What this does, concretely:
//  - While your agent is "thinking" (a spinner is running), FreeAI shows ONE
//    subtle, clickable sponsored line via the active ad surface adapters
//    (today: the status bar — see src/adapters/).
//  - Every 5 seconds it serves is one "impression" — but only if the VS Code
//    window was actually focused for that tick (viewability). Impressions accrue
//    earnings at your revenue share (90%). Clicks are worth 50x an impression.
//  - Nothing about your code, prompts, or output is read or transmitted.

const vscode = require("vscode");
const { createAdapters } = require("./src/adapters");

// --- Spinner frames, in the spirit of the Claude Code asterisk ---
const SPIN_FRAMES = ["✳", "✶", "✷", "✸", "✹", "✺", "✹", "✸", "✷", "✶"];

// --- Loading words (the "Discombobulating…" energy) ---
const WORDS = [
  "Discombobulating",
  "Baking",
  "Percolating",
  "Simmering",
  "Marinating",
  "Noodling",
  "Ruminating",
  "Conjuring",
  "Vibing",
  "Computing",
];

// --- Bundled ad inventory (the live "bid market" / leaderboard) ---
// In production these are fetched from the auction; bundled here so the extension
// works fully offline and you can see exactly what would serve.
const ADS = [
  { brand: "Fluidstack", line: "Fluidstack — building 10GW of compute. Join us.", url: "https://freeai.fyi/go/fluidstack", cat: "infra" },
  { brand: "Ramp", line: "Ramp · save time and money", url: "https://freeai.fyi/go/ramp", cat: "finance" },
  { brand: "Linear", line: "Linear — issue tracking built for speed", url: "https://freeai.fyi/go/linear", cat: "devtools" },
  { brand: "Tuple", line: "Pair with Tuple — how developers build taste", url: "https://freeai.fyi/go/tuple", cat: "devtools" },
  { brand: "Vercel", line: "Vercel · ship your agent to prod", url: "https://freeai.fyi/go/vercel", cat: "infra" },
  { brand: "Neon", line: "Neon · Postgres your agent can branch", url: "https://freeai.fyi/go/neon", cat: "infra" },
  { brand: "Resend", line: "Resend — email for developers", url: "https://freeai.fyi/go/resend", cat: "devtools" },
  { brand: "querybear", line: "querybear.com — Talk to your database with MCP.", url: "https://freeai.fyi/go/querybear", cat: "devtools" },
  { brand: "Solo", line: "Solo — a better place to run your agents", url: "https://freeai.fyi/go/solo", cat: "infra" },
  { brand: "Liner", line: "Liner Search — The most performant & affordable", url: "https://freeai.fyi/go/liner", cat: "ai" },
];

let adapters = [];
let frameIdx = 0;
let adIdx = 0;
let wordIdx = 0;
let spinTimer = null;
let impressionTimer = null;
let activeMode = false; // true while a "thinking" window is showing an ad
let ctx;

// ---- Viewability ----
// An impression only counts if the VS Code window is focused when the 5s tick
// fires — an ad nobody could see is worth nothing to the advertiser, and a
// machine left running overnight shouldn't mint earnings.
let windowFocused = true;

// ---- Killswitch ----
// Server-controlled: if a bad ad slips past moderation we can stop all serving
// instantly via POST /v1/admin/killswitch. The extension checks GET /v1/config
// at startup and every 5 minutes. Local/demo mode (no serverUrl) is unaffected.
let servingAllowed = true;
let killswitchTimer = null;

// ---- Earnings state (persisted in globalState) ----
function getState() {
  return {
    impressions: ctx.globalState.get("bb.impressions", 0),
    clicks: ctx.globalState.get("bb.clicks", 0),
    earnings: ctx.globalState.get("bb.earnings", 0),
    installedAt: ctx.globalState.get("bb.installedAt", Date.now()),
  };
}
function cfg() {
  return vscode.workspace.getConfiguration("freeai");
}
function sharePct() {
  return Math.round(cfg().get("revenueShare", 0.9) * 100);
}
function perImpressionNet() {
  // gross CPM is per 1000 impressions; your share is revenueShare.
  const gross = cfg().get("grossCpm", 12) / 1000;
  return gross * cfg().get("revenueShare", 0.9);
}
function currentAds() {
  const blocked = (cfg().get("blockedCategories", []) || []).map((c) => String(c).toLowerCase());
  const source = serverAds || ADS;
  const list = source.filter((a) => !blocked.includes(a.cat));
  return list.length ? list : source;
}

// ---- server mode (optional) ----
// When freeai.serverUrl is set, ads come from the live auction and
// impressions/clicks are batched to the API so real money settles. With no
// server (or offline), the bundled inventory keeps everything working locally.
let serverAds = null;
let deviceCreds = null; // cached; persisted in SecretStorage (OS keychain)
const pendingEvents = new Map(); // campaignId -> { impressions, clicks }
let flushTimer = null;

function serverUrl() {
  return (cfg().get("serverUrl", "") || "").trim().replace(/\/+$/, "");
}

// Device credentials live in vscode SecretStorage (the OS keychain) so other
// extensions and on-disk state dumps can't read the deviceKey. Pre-0.3 installs
// kept them in globalState — migrate those on first load.
async function loadDeviceCreds() {
  if (ctx.secrets && ctx.secrets.get) {
    try {
      const raw = await ctx.secrets.get("bb.device");
      if (raw) return JSON.parse(raw);
    } catch (_) {
      /* corrupt secret — fall through and re-register */
    }
  }
  const legacy = ctx.globalState.get("bb.device");
  if (legacy && ctx.secrets && ctx.secrets.store) {
    await ctx.secrets.store("bb.device", JSON.stringify(legacy));
    await ctx.globalState.update("bb.device", undefined);
  }
  return legacy || null;
}

async function saveDeviceCreds(creds) {
  if (ctx.secrets && ctx.secrets.store) {
    await ctx.secrets.store("bb.device", JSON.stringify(creds));
  } else {
    await ctx.globalState.update("bb.device", creds);
  }
}

function trackEvent(field) {
  if (!serverAds) return; // local mode: nothing to settle server-side
  const ads = currentAds();
  const ad = ads[adIdx % ads.length];
  if (!ad || !ad.id) return;
  const p = pendingEvents.get(ad.id) || { impressions: 0, clicks: 0 };
  p[field]++;
  pendingEvents.set(ad.id, p);
}

async function flushEvents() {
  const url = serverUrl();
  if (!url || !deviceCreds || !pendingEvents.size) return;
  const events = [...pendingEvents.entries()].map(([campaignId, c]) => ({ campaignId, ...c }));
  try {
    const res = await fetch(url + "/v1/events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        deviceId: deviceCreds.deviceId,
        deviceKey: deviceCreds.deviceKey,
        batchKey: require("crypto").randomUUID(),
        events,
      }),
    });
    if (res.ok) pendingEvents.clear();
  } catch (_) {
    // offline — keep the batch and retry next flush
  }
}

async function checkKillswitch() {
  const url = serverUrl();
  if (!url) return;
  try {
    const r = await fetch(url + "/v1/config");
    if (!r.ok) return;
    const data = await r.json();
    if (typeof data.serving === "boolean") {
      servingAllowed = data.serving;
      if (!servingAllowed && activeMode) stopThinking();
    }
  } catch (_) {
    // unreachable server — keep the last known state
  }
}

async function startServerMode() {
  const url = serverUrl();
  if (!url) return;
  try {
    deviceCreds = await loadDeviceCreds();
    if (!deviceCreds) {
      const r = await fetch(url + "/v1/devices/register", { method: "POST" });
      if (!r.ok) return;
      deviceCreds = await r.json();
      await saveDeviceCreds(deviceCreds);
    }
    await checkKillswitch();
    const r = await fetch(url + "/v1/ads");
    if (!r.ok) return;
    const data = await r.json();
    if (Array.isArray(data.ads) && data.ads.length) {
      serverAds = data.ads.map((a) => ({ ...a, brand: a.brand || a.line }));
    }
    if (flushTimer) clearInterval(flushTimer);
    flushTimer = setInterval(flushEvents, 60000);
    if (killswitchTimer) clearInterval(killswitchTimer);
    killswitchTimer = setInterval(checkKillswitch, 300000);
  } catch (_) {
    // unreachable server — bundled ads keep working
  }
}

function recordImpression() {
  const s = getState();
  ctx.globalState.update("bb.impressions", s.impressions + 1);
  ctx.globalState.update("bb.earnings", s.earnings + perImpressionNet());
  trackEvent("impressions");
}
function recordClick() {
  const s = getState();
  ctx.globalState.update("bb.clicks", s.clicks + 1);
  // a click is worth 50x an impression (local UI counter; server mode settles
  // the real click via the /clicks/intent + /go redirect, not the event batch)
  ctx.globalState.update("bb.earnings", s.earnings + perImpressionNet() * 50);
  trackEvent("clicks");
}

// escape untrusted ad text before putting it in the webview HTML
function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// Open the current ad. In server mode, clicks are counted server-side: we
// request a single-use tracking URL and open that (so the click can't be
// forged). In local/demo mode, open the ad URL directly.
async function openCurrentAd() {
  const ads = currentAds();
  const ad = ads[adIdx % ads.length];
  if (!ad) return;
  recordClick(); // local UI counter
  let target = ad.url;
  const url = serverUrl();
  if (serverAds && url && deviceCreds && ad.id) {
    try {
      const res = await fetch(url + "/v1/clicks/intent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deviceId: deviceCreds.deviceId, deviceKey: deviceCreds.deviceKey, campaignId: ad.id }),
      });
      if (res.ok) target = (await res.json()).trackingUrl || target;
    } catch (_) {
      /* offline — fall back to the direct URL */
    }
  }
  vscode.env.openExternal(vscode.Uri.parse(target));
  renderIdle();
}

// ---- Rendering: fan out the view model to every active surface adapter ----
function renderIdle() {
  const s = getState();
  const model = { earnings: s.earnings, impressions: s.impressions, clicks: s.clicks, sharePct: sharePct() };
  for (const a of adapters) a.renderIdle(model);
}

function renderActiveFrame() {
  const ads = currentAds();
  const model = {
    glyph: SPIN_FRAMES[frameIdx % SPIN_FRAMES.length],
    word: WORDS[wordIdx % WORDS.length],
    ad: ads[adIdx % ads.length],
    sharePct: sharePct(),
  };
  for (const a of adapters) a.renderActive(model);
  frameIdx++;
}

// ---- A "thinking" window: animate spinner + serve ads + count impressions ----
function startThinking(durationMs) {
  if (!cfg().get("enabled", true)) {
    vscode.window.showInformationMessage("FreeAI is disabled. Enable it to earn while you wait.");
    return;
  }
  if (!servingAllowed) return; // server killswitch — stay idle
  activeMode = true;
  adIdx = Math.floor(Math.random() * currentAds().length);

  // animate the spinner ~10fps
  if (spinTimer) clearInterval(spinTimer);
  spinTimer = setInterval(renderActiveFrame, 100);

  // one impression every 5 seconds; rotate the ad + word each impression.
  // Unfocused ticks rotate nothing and pay nothing — see windowFocused.
  if (windowFocused) recordImpression();
  if (impressionTimer) clearInterval(impressionTimer);
  impressionTimer = setInterval(() => {
    if (!windowFocused) return;
    adIdx++;
    wordIdx++;
    recordImpression();
  }, 5000);

  if (durationMs) {
    setTimeout(stopThinking, durationMs);
  }
}

function stopThinking() {
  activeMode = false;
  if (spinTimer) { clearInterval(spinTimer); spinTimer = null; }
  if (impressionTimer) { clearInterval(impressionTimer); impressionTimer = null; }
  renderIdle();
}

// ---- Earnings dashboard webview ----
function showEarnings() {
  const panel = vscode.window.createWebviewPanel(
    "freeaiEarnings",
    "FreeAI — Earnings",
    vscode.ViewColumn.Active,
    { enableScripts: false }
  );
  const s = getState();
  const share = sharePct();
  const days = Math.max(1, Math.round((Date.now() - s.installedAt) / 86400000));
  const perDay = (s.earnings / days).toFixed(2);
  const rows = currentAds()
    .map(
      (a, i) =>
        `<tr><td class="rk">${i + 1}</td><td>${esc(a.line)}</td><td class="brand">${esc(a.brand)}</td></tr>`
    )
    .join("");

  panel.webview.html = `<!doctype html><html><head><meta charset="utf-8">
  <style>
    body { font-family: -apple-system, system-ui, sans-serif; padding: 28px 32px; color: var(--vscode-foreground); }
    h1 { font-size: 22px; margin: 0 0 4px; letter-spacing: -.02em; }
    .muted { color: var(--vscode-descriptionForeground); font-size: 13px; margin: 0 0 24px; }
    .cards { display: grid; grid-template-columns: repeat(3, 1fr); gap: 14px; margin-bottom: 28px; }
    .card { border: 1px solid var(--vscode-panel-border); border-radius: 10px; padding: 16px 18px; }
    .card .n { font-size: 28px; font-weight: 800; letter-spacing: -.03em; }
    .card .l { font-size: 12px; color: var(--vscode-descriptionForeground); margin-top: 2px; }
    .accent .n { color: #34a853; }
    .split { background: rgba(52,168,83,.1); border: 1px solid rgba(52,168,83,.35); border-radius: 10px; padding: 12px 16px; font-size: 13px; margin-bottom: 26px; }
    h2 { font-size: 14px; text-transform: uppercase; letter-spacing: .1em; color: var(--vscode-descriptionForeground); margin: 0 0 10px; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    td { padding: 9px 8px; border-bottom: 1px solid var(--vscode-panel-border); }
    .rk { width: 28px; color: var(--vscode-descriptionForeground); }
    .brand { text-align: right; color: var(--vscode-descriptionForeground); }
  </style></head><body>
    <h1>🤑 You keep ${share}%.</h1>
    <p class="muted">FreeAI pays the developer who watches the spinner. Earnings settle weekly via Stripe.</p>
    <div class="cards">
      <div class="card accent"><div class="n">$${s.earnings.toFixed(2)}</div><div class="l">earned (your ${share}%)</div></div>
      <div class="card"><div class="n">${s.impressions.toLocaleString()}</div><div class="l">impressions</div></div>
      <div class="card"><div class="n">${s.clicks}</div><div class="l">clicks (50× each)</div></div>
    </div>
    <div class="split">Running about <strong>$${perDay}/day</strong> over ${days} day${days > 1 ? "s" : ""}. At this rate it covers your agent subscription — and then some.</div>
    <h2>Live bid market</h2>
    <table>${rows}</table>
  </body></html>`;
}

// ---- Gift card redemption webview ----
// Redeem earned credits for a Claude gift card. Pricing follows the published
// schedule (monthly base × months); the gift card email arrives within 48 hours.
const GIFT_PLANS = [
  { id: "pro", name: "Pro", card: "Claude Pro", tagline: "For the curious", monthlyUsd: 20 },
  { id: "max5x", name: "Max 5x", card: "Claude Max 5x", tagline: "For the enthusiast", monthlyUsd: 100 },
  { id: "max20x", name: "Max 20x", card: "Claude Max 20x", tagline: "For the power user", monthlyUsd: 200 },
];
const GIFT_MONTHS = [1, 3, 6, 12];

async function fetchServerBalance() {
  const url = serverUrl();
  if (!url || !deviceCreds) return null;
  try {
    const r = await fetch(`${url}/v1/me/earnings?deviceId=${deviceCreds.deviceId}&deviceKey=${deviceCreds.deviceKey}`);
    if (!r.ok) return null;
    return (await r.json()).balanceUsd;
  } catch (_) {
    return null;
  }
}

async function showRedeemGiftCard() {
  if (!deviceCreds) deviceCreds = await loadDeviceCreds();
  const serverBalance = await fetchServerBalance();
  const balance = serverBalance != null ? serverBalance : getState().earnings;

  const panel = vscode.window.createWebviewPanel(
    "freeaiRedeem",
    "FreeAI — Redeem",
    vscode.ViewColumn.Active,
    { enableScripts: true }
  );

  panel.webview.onDidReceiveMessage(async (msg) => {
    if (!msg || msg.type !== "redeem") return;
    const url = serverUrl();
    if (!url || !deviceCreds) {
      panel.webview.postMessage({ type: "result", ok: false, error: "Set freeai.serverUrl and earn online to redeem — local demo earnings can't be redeemed." });
      return;
    }
    try {
      const res = await fetch(url + "/v1/redemptions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          deviceId: deviceCreds.deviceId, deviceKey: deviceCreds.deviceKey,
          plan: msg.plan, months: msg.months, recipientEmail: msg.email,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        panel.webview.postMessage({ type: "result", ok: false, error: data.error || "redemption failed" });
        return;
      }
      panel.webview.postMessage({ type: "result", ok: true, balanceUsd: data.balanceUsd });
      vscode.window.showInformationMessage(`FreeAI: gift card redeemed 🎁 — it'll arrive at ${msg.email} within 48 hours.`);
    } catch (_) {
      panel.webview.postMessage({ type: "result", ok: false, error: "Couldn't reach the FreeAI server. Try again." });
    }
  });

  panel.webview.html = `<!doctype html><html><head><meta charset="utf-8">
  <style>
    body { font-family: -apple-system, system-ui, sans-serif; margin: 0; color: #1a1a17; background: #fff; }
    .wrap { display: grid; grid-template-columns: 1fr 1fr; min-height: 100vh; }
    .left { padding: 48px 44px; }
    h1 { font-family: Georgia, 'Times New Roman', serif; font-weight: 500; font-size: 40px; letter-spacing: -.02em; margin: 0 0 14px; }
    .sub { color: #555; font-size: 15px; line-height: 1.5; margin: 0 0 8px; max-width: 460px; }
    .balance { font-size: 13px; color: #777; margin: 0 0 28px; }
    .q { font-size: 14px; font-weight: 600; margin: 22px 0 10px; }
    .opts { display: flex; gap: 12px; flex-wrap: wrap; }
    .opt { border: 1px solid #ddd; border-radius: 14px; padding: 16px 20px; cursor: pointer; background: #fff; text-align: left; min-width: 130px; }
    .opt .t { font-size: 15px; font-weight: 600; color: #1a1a17; }
    .opt .d { font-size: 13px; color: #999; margin-top: 2px; }
    .opt.sel { border: 2px solid #1a1a17; box-shadow: 0 0 0 3px #fff inset; margin: -1px; }
    .opt.month { padding: 16px 24px; }
    .total-l { font-size: 13px; color: #555; margin: 30px 0 2px; }
    .total { font-size: 26px; font-weight: 700; letter-spacing: -.02em; }
    .insuff { color: #c0392b; font-size: 13px; margin-top: 6px; display: none; }
    .emailrow { margin-top: 24px; }
    .emailrow input { width: 320px; max-width: 100%; padding: 10px 12px; border: 1px solid #ddd; border-radius: 10px; font-size: 14px; }
    .note { font-size: 12px; color: #999; margin-top: 8px; }
    .next { margin-top: 30px; background: #1a1a17; color: #fff; border: 0; border-radius: 10px; padding: 12px 34px; font-size: 15px; cursor: pointer; float: right; margin-right: 12px; }
    .next:disabled { opacity: .4; cursor: default; }
    .right { background: #f0efed; display: flex; align-items: center; justify-content: center; }
    .gift { width: 78%; max-width: 480px; aspect-ratio: 16/10; background: #d97757; border-radius: 22px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 26px; box-shadow: 0 18px 40px rgba(0,0,0,.12); }
    .gift .box { font-size: 64px; }
    .gift .label { color: #fff; font-weight: 700; font-size: 19px; }
    .done { display: none; font-size: 15px; line-height: 1.6; margin-top: 28px; padding: 16px 18px; background: #eef7ee; border: 1px solid #bfdfbf; border-radius: 12px; max-width: 460px; }
    .err { display: none; font-size: 14px; margin-top: 18px; color: #c0392b; }
  </style></head><body>
  <div class="wrap">
    <div class="left">
      <h1>Give the gift of Claude</h1>
      <p class="sub">Every plan includes Claude Code, unlimited projects, and access to the latest models. Redeem your FreeAI earnings — your gift card email arrives within 48 hours.</p>
      <p class="balance">Your balance: <strong>$${balance.toFixed(2)}</strong>${serverBalance == null ? " (local demo)" : ""}</p>

      <div class="q">Which plan?</div>
      <div class="opts" id="plans"></div>

      <div class="q">How many months?</div>
      <div class="opts" id="months"></div>

      <div class="total-l">Total</div>
      <div class="total" id="total"></div>
      <div class="insuff" id="insuff">You don't have enough credits for this redemption yet.</div>

      <div class="emailrow">
        <div class="q">Where should we send it?</div>
        <input id="email" type="email" placeholder="you@example.com">
        <div class="note">Gift card emails take up to 48 hours to arrive.</div>
      </div>

      <div class="done" id="done">🎁 Redemption submitted! Your gift card will arrive by email within 48 hours. Your balance has been updated.</div>
      <div class="err" id="err"></div>
      <button class="next" id="next">Next</button>
    </div>
    <div class="right">
      <div class="gift"><div class="box">🎁</div><div class="label" id="cardLabel"></div></div>
    </div>
  </div>
  <script>
    const vscodeApi = acquireVsCodeApi();
    const PLANS = ${JSON.stringify(GIFT_PLANS)};
    const MONTHS = ${JSON.stringify(GIFT_MONTHS)};
    const BALANCE = ${JSON.stringify(balance)};
    let plan = PLANS[0], months = MONTHS[0];

    const plansEl = document.getElementById('plans');
    const monthsEl = document.getElementById('months');
    function render() {
      plansEl.innerHTML = PLANS.map(p =>
        '<button class="opt' + (p.id === plan.id ? ' sel' : '') + '" data-plan="' + p.id + '">' +
        '<div class="t">' + p.name + '</div><div class="d">' + p.tagline + '</div></button>').join('');
      monthsEl.innerHTML = MONTHS.map(m =>
        '<button class="opt month' + (m === months ? ' sel' : '') + '" data-months="' + m + '">' +
        '<div class="t">' + m + ' month' + (m > 1 ? 's' : '') + '</div></button>').join('');
      const total = plan.monthlyUsd * months;
      document.getElementById('total').textContent = 'US$' + total.toFixed(2);
      document.getElementById('cardLabel').textContent = months + ' month' + (months > 1 ? 's' : '') + ' of ' + plan.card;
      const short = total > BALANCE;
      document.getElementById('insuff').style.display = short ? 'block' : 'none';
      document.getElementById('next').disabled = short;
    }
    document.addEventListener('click', (e) => {
      const b = e.target.closest('.opt');
      if (!b) return;
      if (b.dataset.plan) plan = PLANS.find(p => p.id === b.dataset.plan);
      if (b.dataset.months) months = parseInt(b.dataset.months, 10);
      render();
    });
    document.getElementById('next').addEventListener('click', () => {
      const email = document.getElementById('email').value.trim();
      document.getElementById('err').style.display = 'none';
      if (!/^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$/.test(email)) {
        const err = document.getElementById('err');
        err.textContent = 'Enter a valid email address for the gift card.';
        err.style.display = 'block';
        return;
      }
      document.getElementById('next').disabled = true;
      vscodeApi.postMessage({ type: 'redeem', plan: plan.id, months, email });
    });
    window.addEventListener('message', (e) => {
      const msg = e.data;
      if (!msg || msg.type !== 'result') return;
      if (msg.ok) {
        document.getElementById('done').style.display = 'block';
      } else {
        const err = document.getElementById('err');
        err.textContent = msg.error;
        err.style.display = 'block';
        document.getElementById('next').disabled = false;
      }
    });
    render();
  </script>
  </body></html>`;
}

// ---- Auto-show while an integrated terminal (where the agent runs) is focused ----
function wireTerminalAutoShow() {
  vscode.window.onDidChangeActiveTerminal((term) => {
    if (!cfg().get("autoShowOnTerminal", true)) return;
    if (term && !activeMode) {
      // a terminal got focus — likely an agent session; serve while it's open
      startThinking(0); // open-ended; stops when terminal closes/blurs
    } else if (!term && activeMode) {
      stopThinking();
    }
  });
  vscode.window.onDidCloseTerminal(() => {
    if (activeMode && !vscode.window.activeTerminal) stopThinking();
  });
}

function wireViewability(context) {
  windowFocused = vscode.window.state ? !!vscode.window.state.focused : true;
  if (typeof vscode.window.onDidChangeWindowState === "function") {
    context.subscriptions.push(
      vscode.window.onDidChangeWindowState((s) => {
        windowFocused = !!s.focused;
      })
    );
  }
}

function activate(context) {
  ctx = context;
  if (!context.globalState.get("bb.installedAt")) {
    context.globalState.update("bb.installedAt", Date.now());
  }

  adapters = createAdapters(vscode);
  for (const a of adapters) {
    if (a.item) context.subscriptions.push(a.item);
  }

  context.subscriptions.push(
    vscode.commands.registerCommand("freeai.toggle", async () => {
      const c = cfg();
      const now = !c.get("enabled", true);
      await c.update("enabled", now, vscode.ConfigurationTarget.Global);
      if (!now) stopThinking();
      else renderIdle();
      vscode.window.showInformationMessage(
        `FreeAI ${now ? "enabled — earning while you wait 🤑" : "disabled."}`
      );
    }),
    vscode.commands.registerCommand("freeai.simulateAgent", () => {
      vscode.window.showInformationMessage("FreeAI: serving sponsored lines for 30s — watch the status bar.");
      startThinking(30000);
    }),
    vscode.commands.registerCommand("freeai.showEarnings", showEarnings),
    vscode.commands.registerCommand("freeai.redeemGiftCard", showRedeemGiftCard),
    vscode.commands.registerCommand("freeai.openCurrentAd", openCurrentAd),
    vscode.commands.registerCommand("freeai.resetEarnings", async () => {
      await context.globalState.update("bb.impressions", 0);
      await context.globalState.update("bb.clicks", 0);
      await context.globalState.update("bb.earnings", 0);
      renderIdle();
      vscode.window.showInformationMessage("FreeAI earnings reset.");
    })
  );

  wireViewability(context);
  wireTerminalAutoShow();
  startServerMode();
  renderIdle();
}

function deactivate() {
  stopThinking();
  if (flushTimer) clearInterval(flushTimer);
  if (killswitchTimer) clearInterval(killswitchTimer);
  flushEvents(); // best-effort final settle
}

module.exports = { activate, deactivate };
