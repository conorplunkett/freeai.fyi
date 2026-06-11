// Betterbacks.ai — popup logic
const $ = (id) => document.getElementById(id);

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
  $("earnings").textContent = money(s.earnings);
  $("impressions").textContent = (s.impressions || 0).toLocaleString();
  $("clicks").textContent = (s.clicks || 0).toLocaleString();
  $("share").textContent = Math.round((s.revenueShare ?? 0.9) * 100);
  $("enabled").checked = s.enabled !== false;
  const days = Math.max(1, Math.round((Date.now() - (s.installedAt || Date.now())) / 86400000));
  $("perday").textContent = money((s.earnings || 0) / days);
}

function renderBoard() {
  const ads = self.BB_ADS || [];
  $("board").innerHTML = ads
    .map(
      (a, i) =>
        `<li><span class="rk">${i + 1}</span>` +
        `<span class="chip" style="background:${a.color};color:${a.ink}">${a.chip}</span>` +
        `<span class="ln">${a.line}</span></li>`
    )
    .join("");
}

$("enabled").addEventListener("change", async (e) => {
  await send({ type: "BB_SET", payload: { enabled: e.target.checked } });
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab) chrome.tabs.sendMessage(tab.id, { type: "BB_REFRESH" }, () => void chrome.runtime.lastError);
});

$("demo").addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  chrome.tabs.sendMessage(tab.id, { type: "BB_DEMO", ms: 30000 }, () => {
    if (chrome.runtime.lastError) {
      $("hint").textContent = "Open a supported AI site (claude.ai, chatgpt.com…) and try the demo there.";
    } else {
      $("hint").textContent = "Demo running on the active tab — watch the sponsored line for 30s.";
    }
  });
});

$("reset").addEventListener("click", async () => {
  await send({ type: "BB_RESET" });
  refresh();
});

renderBoard();
refresh();
setInterval(refresh, 1000);
