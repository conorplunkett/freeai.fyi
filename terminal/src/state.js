import { readJson, writeJsonAtomic } from "./util.js";

export function initialState({ sessionId, ad, trackingUrl }) {
  return {
    version: 1,
    sessionId,
    active: false,
    activeStartedAt: null,
    lastActiveMs: 0,
    lastHeartbeatMs: 0,
    lastStatusLineMs: 0,
    transcriptPath: "",
    ad: ad ? {
      id: ad.id,
      line: ad.line,
      url: ad.url || "",
      brand: ad.brand || "",
      category: ad.category || "",
      color: ad.color || "",
    } : null,
    trackingUrl: trackingUrl || "",
    impression: {
      sent: false,
      batchKey: "",
      sentAt: 0,
    },
    updatedAt: Date.now(),
  };
}

export function readState(path) {
  return readJson(path, null);
}

export function writeState(path, state) {
  writeJsonAtomic(path, { ...state, updatedAt: Date.now() });
}

export function updateState(path, fn) {
  const state = readState(path) || {};
  const next = fn({ ...state }) || state;
  writeState(path, next);
  return next;
}
