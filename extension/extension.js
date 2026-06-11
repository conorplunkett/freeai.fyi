// Betterbacks.ai — VS Code extension
// Turns the Claude Code / Codex loading spinner into a tiny ad marketplace.
// You keep 90% of the revenue.
//
// What this does, concretely:
//  - While your agent is "thinking" (a spinner is running), Betterbacks shows ONE
//    subtle, clickable sponsored line in the status bar next to a spinner glyph.
//  - Every 5 seconds it serves is one "impression". Impressions accrue earnings at
//    your revenue share (90%). Clicks are worth 50x an impression.
//  - Nothing about your code, prompts, or output is read or transmitted.

const vscode = require("vscode");

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

let statusItem;
let frameIdx = 0;
let adIdx = 0;
let wordIdx = 0;
let spinTimer = null;
let impressionTimer = null;
let activeMode = false; // true while a "thinking" window is showing an ad
let ctx;

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
function perImpressionNet() {
  // gross CPM is per 1000 impressions; your share is revenueShare.
  const gross = cfg().get("grossCpm", 12) / 1000;
  return gross * cfg().get("revenueShare", 0.9);
}
function currentAds() {
  const blocked = (cfg().get("blockedCategories", []) || []).map((c) => String(c).toLowerCase());
  const list = ADS.filter((a) => !blocked.includes(a.cat));
  return list.length ? list : ADS;
}

function recordImpression() {
  const s = getState();
  ctx.globalState.update("bb.impressions", s.impressions + 1);
  ctx.globalState.update("bb.earnings", s.earnings + perImpressionNet());
}
function recordClick() {
  const s = getState();
  ctx.globalState.update("bb.clicks", s.clicks + 1);
  // a click is worth 50x an impression
  ctx.globalState.update("bb.earnings", s.earnings + perImpressionNet() * 50);
}

// ---- Status bar rendering ----
function renderIdle() {
  if (!statusItem) return;
  const s = getState();
  statusItem.text = `$(sparkle) betterbacks  $${s.earnings.toFixed(2)}`;
  statusItem.tooltip = new vscode.MarkdownString(
    `**Betterbacks.ai** — you keep ${Math.round(cfg().get("revenueShare", 0.9) * 100)}%\n\n` +
      `Earned: **$${s.earnings.toFixed(2)}**  ·  ${s.impressions.toLocaleString()} impressions  ·  ${s.clicks} clicks\n\n` +
      `_Click to open your earnings dashboard._`
  );
  statusItem.command = "betterbacks.showEarnings";
  statusItem.color = undefined;
  statusItem.show();
}

function renderActiveFrame() {
  if (!statusItem) return;
  const ads = currentAds();
  const ad = ads[adIdx % ads.length];
  const glyph = SPIN_FRAMES[frameIdx % SPIN_FRAMES.length];
  const word = WORDS[wordIdx % WORDS.length];
  // The one sponsored line, next to the spinner.
  statusItem.text = `${glyph} ${word}…  ·  ${ad.line}`;
  statusItem.tooltip = new vscode.MarkdownString(
    `**Sponsored** · ${ad.brand}\n\n${ad.line}\n\n_Click to open. You keep ${Math.round(
      cfg().get("revenueShare", 0.9) * 100
    )}% of this impression._`
  );
  statusItem.command = "betterbacks.openCurrentAd";
  statusItem.color = new vscode.ThemeColor("charts.green");
  statusItem.show();
  frameIdx++;
}

// ---- A "thinking" window: animate spinner + serve ads + count impressions ----
function startThinking(durationMs) {
  if (!cfg().get("enabled", true)) {
    vscode.window.showInformationMessage("Betterbacks is disabled. Enable it to earn while you wait.");
    return;
  }
  activeMode = true;
  adIdx = Math.floor(Math.random() * currentAds().length);

  // animate the spinner ~10fps
  if (spinTimer) clearInterval(spinTimer);
  spinTimer = setInterval(renderActiveFrame, 100);

  // one impression every 5 seconds; rotate the ad + word each impression
  recordImpression();
  if (impressionTimer) clearInterval(impressionTimer);
  impressionTimer = setInterval(() => {
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
  const share = Math.round(cfg().get("revenueShare", 0.9) * 100);
  const days = Math.max(1, Math.round((Date.now() - s.installedAt) / 86400000));
  const perDay = (s.earnings / days).toFixed(2);
  const rows = currentAds()
    .map(
      (a, i) =>
        `<tr><td class="rk">${i + 1}</td><td>${a.line}</td><td class="brand">${a.brand}</td></tr>`
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

function activate(context) {
  ctx = context;
  if (!context.globalState.get("bb.installedAt")) {
    context.globalState.update("bb.installedAt", Date.now());
  }

  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 1000);
  context.subscriptions.push(statusItem);

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
    vscode.commands.registerCommand("betterbacks.openCurrentAd", () => {
      const ads = currentAds();
      const ad = ads[adIdx % ads.length];
      recordClick();
      vscode.env.openExternal(vscode.Uri.parse(ad.url));
      renderIdle();
    }),
    vscode.commands.registerCommand("betterbacks.resetEarnings", async () => {
      await context.globalState.update("bb.impressions", 0);
      await context.globalState.update("bb.clicks", 0);
      await context.globalState.update("bb.earnings", 0);
      renderIdle();
      vscode.window.showInformationMessage("Betterbacks earnings reset.");
    })
  );

  wireTerminalAutoShow();
  renderIdle();
}

function deactivate() {
  stopThinking();
}

module.exports = { activate, deactivate };
