// FreeAI.fyi — service worker
// Holds earnings state and the revenue math. 50% comes back as Claude credits.

importScripts("ads.js");

const DEFAULTS = {
  enabled: true,
  testMode: false, // show the mock ad continuously so you can verify the loop
  revenueShare: 0.5, // your cut, redeemable as Claude credits
  grossCpm: 12, // gross USD per 1,000 five-second impressions
  blockedCategories: [],
  impressions: 0,
  clicks: 0,
  earnings: 0,
  // Test Mode events are kept in their own counters so they never pollute real,
  // billable earnings — the popup surfaces them only while Test Mode is on.
  testImpressions: 0,
  testClicks: 0,
  installedAt: Date.now(),
};

async function getState() {
  const s = await chrome.storage.local.get(Object.keys(DEFAULTS));
  return { ...DEFAULTS, ...s, mockAd: self.BB_MOCK_AD };
}

function perImpressionNet(s) {
  return (s.grossCpm / 1000) * s.revenueShare;
}

async function recordImpression(mock) {
  const s = await getState();
  if (!s.enabled) return s;
  // Mock impressions (Test Mode) tick a separate counter and earn nothing real.
  const next = mock
    ? { testImpressions: s.testImpressions + 1 }
    : {
        impressions: s.impressions + 1,
        earnings: +(s.earnings + perImpressionNet(s)).toFixed(6),
      };
  await chrome.storage.local.set(next);
  return { ...s, ...next };
}

async function recordClick(mock) {
  const s = await getState();
  const next = mock
    ? { testClicks: s.testClicks + 1 }
    : {
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
        sendResponse(await recordImpression(!!msg.mock));
        break;
      case "BB_CLICK":
        sendResponse(await recordClick(!!msg.mock));
        break;
      case "BB_SET":
        await chrome.storage.local.set(msg.payload || {});
        sendResponse(await getState());
        break;
      case "BB_RESET":
        await chrome.storage.local.set({ impressions: 0, clicks: 0, earnings: 0, testImpressions: 0, testClicks: 0 });
        sendResponse(await getState());
        break;
      default:
        sendResponse({ ok: false });
    }
  })();
  return true; // async response
});
