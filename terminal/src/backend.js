import { randomUUID } from "node:crypto";
import { devicePath, resolveApiBase } from "./paths.js";
import { readJson, safeHttpUrl, writeJsonAtomic } from "./util.js";

export class FreeAiBackend {
  constructor({ base, fetchImpl = fetch, timeoutMs = 3000 } = {}) {
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
    })).filter((ad) => ad.id && ad.line);
  }

  async registerDevice() {
    const res = await this.request("/v1/devices/register", { method: "POST" });
    if (!res.ok) throw new Error(`device register ${res.status}`);
    const body = await res.json();
    if (!body?.deviceId || !body?.deviceKey) throw new Error("bad device response");
    return { deviceId: String(body.deviceId), deviceKey: String(body.deviceKey) };
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
