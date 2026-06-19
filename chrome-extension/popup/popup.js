// FreeAI.fyi — popup logic
const $ = (id) => document.getElementById(id);
const setText = (id, val) => { const el = $(id); if (el) el.textContent = val; };

// A free month of Claude Pro = $20. The hero progress line tracks credits
// earned toward that next free month.
const MONTH_TARGET = 20;

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

async function refresh() {
  const s = (await send({ type: "BB_GET_STATE" })) || {};
  const earnings = s.earnings || 0;
  setText("earnings", money(earnings));
  setText("impressions", (s.impressions || 0).toLocaleString());
  setText("clicks", (s.clicks || 0).toLocaleString());
  $("enabled").checked = s.enabled !== false;
  const days = Math.max(1, Math.round((Date.now() - (s.installedAt || Date.now())) / 86400000));
  setText("perday", money(earnings / days));

  // Hero progress toward the next free month of Claude.
  const progress = $("progress");
  if (progress) {
    const pct = Math.min(100, Math.round((earnings / MONTH_TARGET) * 100));
    progress.innerHTML =
      pct >= 100
        ? "<b>Ready</b> — redeem a free month of Claude"
        : `<b>${pct}%</b> toward your next free month of Claude`;
  }

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

function renderBoard() {
  const ads = self.BB_ADS || [];
  $("board").innerHTML = ads
    .map(
      (a, i) =>
        `<li><span class="rk">${i + 1}</span>` +
        `<span class="chip" style="background:${a.color};color:${a.ink}">${a.chip}</span>` +
        `<span class="nm">${a.brand}</span>` +
        `<span class="ln">— ${a.line}</span></li>`
    )
    .join("");
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

renderBoard();
refresh();
setInterval(refresh, 1000);
