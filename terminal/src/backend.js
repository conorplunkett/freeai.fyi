import { randomUUID } from "node:crypto";
import { devicePath, resolveApiBase } from "./paths.js";
import { readJson, safeHttpUrl, writeJsonAtomic } from "./util.js";

export class FreeAiBackend {
  constructor({ base, fetchImpl = fetch, timeoutMs = 8000 } = {}) {
    this.base = String(base || "").replace(/\/+$/, "");
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  async request(path, init = {}) {
    const signal = init.signal ?? AbortSignal.timeout(this.timeoutMs);
    return this.fetchImpl(`${this.base}${path}`, { ...init, signal });
  }

  async config() {
    const res = await this.request("/v1/config");
    if (!res.ok) throw new Error(`config ${res.status}`);
    const body = await res.json();
    return { serving: body?.serving !== false, revenueShare: body?.revenueShare };
  }

  async ads() {
    const res = await this.request("/v1/ads");
    if (!res.ok) throw new Error(`ads ${res.status}`);
    const body = await res.json();
    return (body?.ads || []).map((ad) => ({
      id: String(ad.id || ""),
      line: String(ad.line || ad.brand || ""),
      url: safeHttpUrl(ad.url || ""),
      brand: typeof ad.brand === "string" ? ad.brand : undefined,
      category: typeof ad.cat === "string" ? ad.cat : undefined,
      color: typeof ad.color === "string" ? ad.color : undefined,
    })).filter((ad) => ad.id && ad.line);
  }

  async registerDevice() {
    const res = await this.request("/v1/devices/register", { method: "POST" });
    if (!res.ok) throw new Error(`device register ${res.status}`);
    const body = await res.json();
    if (!body?.deviceId || !body?.deviceKey) throw new Error("bad device response");
    return { deviceId: String(body.deviceId), deviceKey: String(body.deviceKey) };
  }

  // Email magic-link sign-in, mirroring the Chrome extension's
  // requestSignInLink (POST /v1/auth/request-link, authed by device creds). The
  // click in the email hits /v1/auth/verify, which sets devices.user_id — after
  // which this device's Claude Code credits attribute to the user's account.
  async requestEmailLink(device, email) {
    const res = await this.request("/v1/auth/request-link", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email,
        deviceId: device.deviceId,
        deviceKey: device.deviceKey,
      }),
    });
    if (!res.ok) {
      let detail = "";
      try { detail = (await res.json())?.error || ""; } catch { /* ignore */ }
      throw new Error(detail || `request-link ${res.status}`);
    }
    const body = await res.json().catch(() => ({}));
    return { ok: true, sent: body?.sent !== false };
  }

  // Whether this device is already linked to a user account. GET
  // /v1/me/affiliate takes device creds in the query string.
  async linkStatus(device) {
    const qs = new URLSearchParams({
      deviceId: device.deviceId,
      deviceKey: device.deviceKey,
    });
    const res = await this.request(`/v1/me/affiliate?${qs}`);
    if (!res.ok) throw new Error(`affiliate ${res.status}`);
    const body = await res.json();
    return { linked: !!body?.linked, email: typeof body?.email === "string" ? body.email : null };
  }

  async createClickIntent(device, campaignId) {
    const res = await this.request("/v1/clicks/intent", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        deviceId: device.deviceId,
        deviceKey: device.deviceKey,
        campaignId,
      }),
    });
    if (!res.ok) throw new Error(`click intent ${res.status}`);
    const body = await res.json();
    const trackingUrl = safeHttpUrl(body?.trackingUrl || "");
    if (!trackingUrl) throw new Error("bad click intent response");
    return trackingUrl;
  }

  async sendImpression(device, campaignId, batchKey = randomUUID()) {
    const res = await this.request("/v1/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        deviceId: device.deviceId,
        deviceKey: device.deviceKey,
        batchKey,
        // Tags credits with the surface so the portal's Install tab can light up
        // the per-service "active" logo (grey → colored on the first credit).
        source: "claude_code",
        events: [{ campaignId, impressions: 1, clicks: 0 }],
      }),
    });
    if (!res.ok && res.status !== 429) throw new Error(`events ${res.status}`);
    return { ok: res.ok, capped: res.status === 429 };
  }
}

export function readDevice(home) {
  const device = readJson(devicePath(home), null);
  return device?.deviceId && device?.deviceKey
    ? { deviceId: String(device.deviceId), deviceKey: String(device.deviceKey) }
    : null;
}

export function writeDevice(home, device) {
  writeJsonAtomic(devicePath(home), device);
}

export async function ensureDevice(home, backend) {
  const cached = readDevice(home);
  if (cached) return cached;
  const device = await backend.registerDevice();
  writeDevice(home, device);
  return device;
}

export function defaultBackend({ home, env, fetchImpl } = {}) {
  return new FreeAiBackend({ base: resolveApiBase({ home, env }), fetchImpl });
}

// Same shape the backend validates with (POST /v1/auth/request-link) and the
// Chrome extension popup uses, so a typo fails locally instead of round-tripping.
export const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

// Ensure a device exists, then email a magic link that links it to `email`'s
// account. Network-only: callers persist any local "link requested" marker.
export async function linkAccountEmail(home, backend, email) {
  const clean = String(email || "").trim();
  if (!EMAIL_RE.test(clean)) throw new Error("valid email required");
  const device = await ensureDevice(home, backend);
  const result = await backend.requestEmailLink(device, clean);
  return { ...result, email: clean, deviceId: device.deviceId };
}
