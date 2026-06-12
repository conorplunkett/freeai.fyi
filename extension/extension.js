// Betterbacks.ai — VS Code extension
// Turns the Claude Code / Codex loading spinner into a tiny ad marketplace.
// You keep 90% of the revenue.
//
// What this does, concretely:
//  - While your agent is "thinking" (a spinner is running), Betterbacks shows ONE
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
  { brand: "Fluidstack", line: "Fluidstack — building 10GW of compute. Join us.", url: "https://betterbacks.ai/go/fluidstack", cat: "infra" },
  { brand: "Ramp", line: "Ramp · save time and money", url: "https://betterbacks.ai/go/ramp", cat: "finance" },
  { brand: "Linear", line: "Linear — issue tracking built for speed", url: "https://betterbacks.ai/go/linear", cat: "devtools" },
  { brand: "Tuple", line: "Pair with Tuple — how developers build taste", url: "https://betterbacks.ai/go/tuple", cat: "devtools" },
  { brand: "Vercel", line: "Vercel · ship your agent to prod", url: "https://betterbacks.ai/go/vercel", cat: "infra" },
  { brand: "Neon", line: "Neon · Postgres your agent can branch", url: "https://betterbacks.ai/go/neon", cat: "infra" },
  { brand: "Resend", line: "Resend — email for developers", url: "https://betterbacks.ai/go/resend", cat: "devtools" },
  { brand: "querybear", line: "querybear.com — Talk to your database with MCP.", url: "https://betterbacks.ai/go/querybear", cat: "devtools" },
  { brand: "Solo", line: "Solo — a better place to run your agents", url: "https://betterbacks.ai/go/solo", cat: "infra" },
  { brand: "Liner", line: "Liner Search — The most performant & affordable", url: "https://betterbacks.ai/go/liner", cat: "ai" },
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
  return vscode.workspace.getConfiguration("betterbacks");
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
// When betterbacks.serverUrl is set, ads come from the live auction and
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
    vscode.window.showInformationMessage("Betterbacks is disabled. Enable it to earn while you wait.");
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
    "betterbacksEarnings",
    "Betterbacks — Earnings",
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
    <p class="muted">Betterbacks pays the developer who watches the spinner. Earnings settle weekly via Stripe.</p>
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
    vscode.commands.registerCommand("betterbacks.toggle", async () => {
      const c = cfg();
      const now = !c.get("enabled", true);
      await c.update("enabled", now, vscode.ConfigurationTarget.Global);
      if (!now) stopThinking();
      else renderIdle();
      vscode.window.showInformationMessage(
        `Betterbacks ${now ? "enabled — earning while you wait 🤑" : "disabled."}`
      );
    }),
    vscode.commands.registerCommand("betterbacks.simulateAgent", () => {
      vscode.window.showInformationMessage("Betterbacks: serving sponsored lines for 30s — watch the status bar.");
      startThinking(30000);
    }),
    vscode.commands.registerCommand("betterbacks.showEarnings", showEarnings),
    vscode.commands.registerCommand("betterbacks.openCurrentAd", openCurrentAd),
    vscode.commands.registerCommand("betterbacks.resetEarnings", async () => {
      await context.globalState.update("bb.impressions", 0);
      await context.globalState.update("bb.clicks", 0);
      await context.globalState.update("bb.earnings", 0);
      renderIdle();
      vscode.window.showInformationMessage("Betterbacks earnings reset.");
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
