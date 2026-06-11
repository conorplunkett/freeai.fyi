// Betterbacks.ai — service worker
// Holds earnings state and the revenue math. You keep 90%.

importScripts("ads.js");

const DEFAULTS = {
  enabled: true,
  revenueShare: 0.9, // your cut — the better split
  grossCpm: 12, // gross USD per 1,000 five-second impressions
  blockedCategories: [],
  impressions: 0,
  clicks: 0,
  earnings: 0,
  installedAt: Date.now(),
};

async function getState() {
  const s = await chrome.storage.local.get(Object.keys(DEFAULTS));
  return { ...DEFAULTS, ...s };
}

function perImpressionNet(s) {
  return (s.grossCpm / 1000) * s.revenueShare;
}

async function recordImpression() {
  const s = await getState();
  if (!s.enabled) return s;
  const next = {
    impressions: s.impressions + 1,
    earnings: +(s.earnings + perImpressionNet(s)).toFixed(6),
  };
  await chrome.storage.local.set(next);
  return { ...s, ...next };
}

async function recordClick() {
  const s = await getState();
  const next = {
    clicks: s.clicks + 1,
    earnings: +(s.earnings + perImpressionNet(s) * 50).toFixed(6), // click = 50x impression
  };
  await chrome.storage.local.set(next);
  return { ...s, ...next };
}

chrome.runtime.onInstalled.addListener(async () => {
  const has = await chrome.storage.local.get("installedAt");
  if (!has.installedAt) {
    await chrome.storage.local.set({ ...DEFAULTS });
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    switch (msg.type) {
      case "BB_GET_STATE":
        sendResponse(await getState());
        break;
      case "BB_GET_ADS": {
        const s = await getState();
        const blocked = (s.blockedCategories || []).map((c) => String(c).toLowerCase());
        const ads = self.BB_ADS.filter((a) => !blocked.includes(a.cat));
        sendResponse(ads.length ? ads : self.BB_ADS);
        break;
      }
      case "BB_IMPRESSION":
        sendResponse(await recordImpression());
        break;
      case "BB_CLICK":
        sendResponse(await recordClick());
        break;
      case "BB_SET":
        await chrome.storage.local.set(msg.payload || {});
        sendResponse(await getState());
        break;
      case "BB_RESET":
        await chrome.storage.local.set({ impressions: 0, clicks: 0, earnings: 0 });
        sendResponse(await getState());
        break;
      default:
        sendResponse({ ok: false });
    }
  })();
  return true; // async response
});
