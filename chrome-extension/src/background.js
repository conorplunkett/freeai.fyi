// FreeAI.fyi — service worker
// Holds earnings state and the revenue math. 50% comes back as Claude credits.
//
// Talks to the production backend (Supabase Edge Function):
//   • registers an anonymous device (deviceId + deviceKey)
//   • pulls the live ad inventory from the auction (/v1/ads)
//   • reports impressions to the ledger (/v1/events, idempotent batches)
//   • records clicks through single-use, forgery-proof tokens (/v1/clicks/intent)
//   • honours the server killswitch (/v1/config → serving)
// All network use is feature-guarded so the headless test harness (no fetch /
// alarms / crypto) still exercises the local revenue math unchanged.

importScripts("ads.js");

const API_BASE = "https://wpjfhezklpczxzocgxsb.supabase.co/functions/v1/api";

const DEFAULTS = {
  enabled: true,
  testMode: false, // show the mock ad continuously so you can verify the loop
  serving: true, // mirrors the server killswitch (/v1/config); ads off when false
  revenueShare: 0.5, // your cut, redeemable as Claude credits (server may override)
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
  // Real impressions also queue for the prod ledger (flushed in batches below).
  let next;
  if (mock) {
    next = { testImpressions: s.testImpressions + 1 };
  } else {
    const { pendingImpressions = 0 } = await chrome.storage.local.get(["pendingImpressions"]);
    next = {
      impressions: s.impressions + 1,
      earnings: +(s.earnings + perImpressionNet(s)).toFixed(6),
      pendingImpressions: pendingImpressions + 1,
    };
  }
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

// ---------- prod backend ----------
// Server ads are { id, brand, line, url, cat } with no presentational fields;
// the injected bar renders a chip + colours, so derive them deterministically.
const AD_PALETTE = [
  { color: "#1d6cff", ink: "#fff" },
  { color: "#5b5bd6", ink: "#fff" },
  { color: "#00e599", ink: "#04130a" },
  { color: "#ffd54a", ink: "#1b1e25" },
  { color: "#111111", ink: "#fff" },
  { color: "#7c3aed", ink: "#fff" },
  { color: "#0ea5e9", ink: "#fff" },
  { color: "#10b981", ink: "#fff" },
  { color: "#f59e0b", ink: "#1b1e25" },
];
function decorateAd(a) {
  const brand = a.brand || "";
  const chip = ((brand.match(/[A-Za-z0-9]/) || ["•"])[0]).toUpperCase();
  let h = 0;
  for (let i = 0; i < brand.length; i++) h = (h * 31 + brand.charCodeAt(i)) >>> 0;
  const pal = AD_PALETTE[h % AD_PALETTE.length];
  return { id: a.id, brand, chip, color: pal.color, ink: pal.ink, line: a.line, url: a.url, cat: a.cat || "other" };
}

async function getDevice() {
  const { deviceId, deviceKey } = await chrome.storage.local.get(["deviceId", "deviceKey"]);
  return deviceId && deviceKey ? { deviceId, deviceKey } : null;
}

async function getOrRegisterDevice() {
  const existing = await getDevice();
  if (existing) return existing;
  if (typeof fetch !== "function") return null;
  try {
    const res = await fetch(`${API_BASE}/v1/devices/register`, { method: "POST" });
    if (!res.ok) return null;
    const { deviceId, deviceKey } = await res.json();
    if (deviceId && deviceKey) {
      await chrome.storage.local.set({ deviceId, deviceKey });
      return { deviceId, deviceKey };
    }
  } catch (_) {}
  return null;
}

async function refreshConfig() {
  if (typeof fetch !== "function") return;
  try {
    const res = await fetch(`${API_BASE}/v1/config`);
    if (!res.ok) return;
    const data = await res.json();
    const patch = {};
    if (typeof data.serving === "boolean") patch.serving = data.serving;
    if (typeof data.revenueShare === "number") patch.revenueShare = data.revenueShare;
    if (Object.keys(patch).length) await chrome.storage.local.set(patch);
  } catch (_) {}
}

async function refreshAds() {
  if (typeof fetch !== "function") return;
  try {
    const res = await fetch(`${API_BASE}/v1/ads`);
    if (!res.ok) return;
    const data = await res.json();
    const ads = Array.isArray(data.ads) ? data.ads.map(decorateAd) : [];
    const patch = { liveAds: ads, adsFetchedAt: Date.now() };
    if (typeof data.revenueShare === "number") patch.revenueShare = data.revenueShare;
    await chrome.storage.local.set(patch);
  } catch (_) {}
}

// Impressions report in idempotent batches; the server dedups on batchKey, so a
// failed POST simply folds the count back and retries on the next flush.
let flushing = false;
async function foldBackPending(impressions) {
  const { pendingImpressions = 0 } = await chrome.storage.local.get(["pendingImpressions"]);
  await chrome.storage.local.set({ pendingImpressions: pendingImpressions + impressions });
}
async function flushEvents() {
  if (typeof fetch !== "function" || flushing) return;
  const { pendingImpressions = 0 } = await chrome.storage.local.get(["pendingImpressions"]);
  if (pendingImpressions <= 0) return;
  const device = await getOrRegisterDevice();
  if (!device) return;
  flushing = true;
  await chrome.storage.local.set({ pendingImpressions: 0 }); // claim
  const batchKey =
    typeof crypto !== "undefined" && crypto.randomUUID
      ? crypto.randomUUID()
      : `b_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  try {
    const res = await fetch(`${API_BASE}/v1/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        deviceId: device.deviceId,
        deviceKey: device.deviceKey,
        batchKey,
        // Tags credits with the surface so the portal's Install tab can light up
        // the per-service "active" logo (grey → colored on the first credit).
        source: "chrome",
        events: [{ impressions: pendingImpressions, clicks: 0 }],
      }),
    });
    // 429 = daily cap; drop those (they reset next UTC day). Other failures retry.
    if (!res.ok && res.status !== 429) await foldBackPending(pendingImpressions);
  } catch (_) {
    await foldBackPending(pendingImpressions);
  } finally {
    flushing = false;
  }
}

// Forgery-proof click: ask the server for a single-use token tied to this
// device + campaign, then redeem it so the click is recorded server-side. The
// user's own navigation stays the synchronous window.open in the content script.
async function reportClick(campaignId) {
  if (typeof fetch !== "function" || !campaignId) return;
  const device = await getOrRegisterDevice();
  if (!device) return;
  try {
    const res = await fetch(`${API_BASE}/v1/clicks/intent`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deviceId: device.deviceId, deviceKey: device.deviceKey, campaignId }),
    });
    if (!res.ok) return;
    const { trackingUrl } = await res.json();
    if (trackingUrl) {
      try { await fetch(trackingUrl, { redirect: "manual" }); } catch (_) {}
    }
  } catch (_) {}
}

async function refreshAll() {
  await getOrRegisterDevice();
  await refreshConfig();
  await refreshAds();
  await flushEvents();
}

// ---------- crew (affiliate) ----------
// The popup's "earn with your friends" panel. The extension stays anonymous; the
// device links to a user via the magic link from /v1/auth/request-link. Once
// linked, the user is auto-enrolled as an approved affiliate, and the
// device-scoped /v1/me/affiliate returns the invite link + per-friend 10%
// breakdown — no web session, just device credentials. While unlinked it returns
// { linked:false } and the popup shows the sign-in CTA.
async function getCrew() {
  const device = await getDevice();
  if (!device || typeof fetch !== "function") return { linked: false, friends: [] };
  try {
    const qs = `deviceId=${encodeURIComponent(device.deviceId)}&deviceKey=${encodeURIComponent(device.deviceKey)}`;
    const res = await fetch(`${API_BASE}/v1/me/affiliate?${qs}`);
    if (!res.ok) return { linked: false, friends: [] };
    return await res.json();
  } catch (_) {
    return { linked: false, friends: [] };
  }
}

// Kick off email sign-in from the popup: link this device to a user account via a
// magic link. authed by the device credentials. The click in the email hits
// /v1/auth/verify, which sets devices.user_id — after which getCrew() goes linked.
async function requestSignInLink(email) {
  if (typeof fetch !== "function") return { ok: false };
  const device = await getOrRegisterDevice();
  if (!device) return { ok: false, error: "no device" };
  try {
    const res = await fetch(`${API_BASE}/v1/auth/request-link`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, deviceId: device.deviceId, deviceKey: device.deviceKey }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      return { ok: false, error: data.error || "couldn't send the link" };
    }
    return { ok: true, sent: true };
  } catch (_) {
    return { ok: false, error: "network error" };
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  const has = await chrome.storage.local.get("installedAt");
  if (!has.installedAt) {
    await chrome.storage.local.set({ ...DEFAULTS });
  }
  refreshAll();
});

// Service workers get evicted, so periodic work runs off alarms (when available).
if (chrome.alarms) {
  chrome.alarms.create("freeai-refresh", { periodInMinutes: 10 });
  chrome.alarms.create("freeai-flush", { periodInMinutes: 1 });
  chrome.alarms.onAlarm.addListener((a) => {
    if (a.name === "freeai-refresh") refreshAll();
    else if (a.name === "freeai-flush") flushEvents();
  });
}
if (chrome.runtime.onStartup) chrome.runtime.onStartup.addListener(() => refreshAll());

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    switch (msg.type) {
      case "BB_GET_STATE":
        sendResponse(await getState());
        break;
      case "BB_GET_CREW":
        sendResponse(await getCrew());
        break;
      case "BB_SIGNIN":
        sendResponse(await requestSignInLink((msg.email || "").trim()));
        break;
      case "BB_GET_ADS": {
        const s = await getState();
        const blocked = (s.blockedCategories || []).map((c) => String(c).toLowerCase());
        // Prefer live inventory from the auction; fall back to the bundled list
        // when offline or before the first fetch. Category blocking applies to both.
        const { liveAds } = await chrome.storage.local.get(["liveAds"]);
        const source = Array.isArray(liveAds) && liveAds.length ? liveAds : self.BB_ADS;
        const ads = source.filter((a) => !blocked.includes(a.cat));
        sendResponse(ads.length ? ads : source);
        break;
      }
      case "BB_IMPRESSION": {
        const s = await recordImpression(!!msg.mock);
        sendResponse(s);
        if (!msg.mock) flushEvents();
        break;
      }
      case "BB_CLICK": {
        const s = await recordClick(!!msg.mock);
        sendResponse(s);
        if (!msg.mock) reportClick(msg.campaignId);
        break;
      }
      case "BB_SET":
        await chrome.storage.local.set(msg.payload || {});
        sendResponse(await getState());
        break;
      case "BB_RESET":
        await chrome.storage.local.set({ impressions: 0, clicks: 0, earnings: 0, testImpressions: 0, testClicks: 0, pendingImpressions: 0 });
        sendResponse(await getState());
        break;
      default:
        sendResponse({ ok: false });
    }
  })();
  return true; // async response
});
