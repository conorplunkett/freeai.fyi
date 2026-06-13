import { describe, it, expect, vi } from "vitest";
import { createFreeAiFetch, globalStateDeviceStore, type DeviceStore, type Device }
  from "../src/freeaiApi/translate";

const BASE = "https://api.freeai.fyi";

function memStore(seed: Device | null = null): DeviceStore {
  let d = seed;
  return { async get() { return d; }, async set(x) { d = x; } };
}

// A fake FreeAI server: records calls and returns canned responses keyed by
// "METHOD /path". Anything unmatched 404s (lets us assert passthrough).
function fakeServer(handlers: Record<string, (init?: RequestInit) => Response>) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const f = vi.fn(async (input: any, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const path = new URL(url).pathname;
    const key = `${init?.method || "GET"} ${path}`;
    const h = handlers[key];
    return h ? h(init) : new Response("not found", { status: 404 });
  });
  return { f: f as unknown as typeof fetch, calls };
}

const ok = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200,
    headers: { "content-type": "application/json" } });

describe("freeaiApi translating fetch", () => {
  it("maps /v1/portfolio onto /v1/ads in the S2 portfolio shape", async () => {
    const { f } = fakeServer({
      "GET /v1/ads": () => ok({ revenueShare: 0.5, ads: [
        { id: "c1", brand: "Linear", line: "issue tracking", url: "https://linear.app", cat: "dev" },
      ] }),
    });
    const fetchT = createFreeAiFetch({ base: BASE, device: memStore(), realFetch: f });
    const r = await fetchT(`${BASE}/v1/portfolio?claude_code_version=2.1`);
    expect(r.ok).toBe(true);
    const j = await r.json();
    expect(j.ads).toHaveLength(1);
    expect(j.ads[0]).toMatchObject({
      ad_id: "c1", campaign_id: "c1", title_text: "issue tracking",
      click_url: "https://linear.app",
    });
    expect(j.view_threshold_seconds).toBe(5);
  });

  it("treats the demo portfolio path identically (device-credited)", async () => {
    const { f } = fakeServer({ "GET /v1/ads": () => ok({ ads: [] }) });
    const fetchT = createFreeAiFetch({ base: BASE, device: memStore(), realFetch: f });
    const r = await fetchT(`${BASE}/v1/portfolio/demo?client_id=x`);
    const j = await r.json();
    expect(r.ok).toBe(true);
    expect(j.ads).toEqual([]);
  });

  it("maps /v1/killswitch onto /v1/config (serving=false ⇒ killed)", async () => {
    const { f } = fakeServer({ "GET /v1/config": () => ok({ serving: false, revenueShare: 0.5 }) });
    const fetchT = createFreeAiFetch({ base: BASE, device: memStore(), realFetch: f });
    const j = await (await fetchT(`${BASE}/v1/killswitch?version=2.1&campaign=`)).json();
    expect(j.killed).toBe(true);
  });

  it("serving=true ⇒ not killed", async () => {
    const { f } = fakeServer({ "GET /v1/config": () => ok({ serving: true }) });
    const fetchT = createFreeAiFetch({ base: BASE, device: memStore(), realFetch: f });
    const j = await (await fetchT(`${BASE}/v1/killswitch?version=2.1&campaign=`)).json();
    expect(j.killed).toBe(false);
  });

  it("config unreachable ⇒ non-2xx so the client takes its offline branch", async () => {
    const f = vi.fn(async () => { throw new Error("offline"); }) as unknown as typeof fetch;
    const fetchT = createFreeAiFetch({ base: BASE, device: memStore(), realFetch: f });
    const r = await fetchT(`${BASE}/v1/killswitch?version=2.1&campaign=`);
    expect(r.ok).toBe(false);
  });

  it("view_threshold_met posts exactly one impression to /v1/events with the device", async () => {
    const { f, calls } = fakeServer({
      "POST /v1/events": () => ok({ ok: true }),
    });
    const store = memStore({ deviceId: "d1", deviceKey: "k1" });
    const fetchT = createFreeAiFetch({ base: BASE, device: store, realFetch: f });
    const r = await fetchT(`${BASE}/v1/metrics`, {
      method: "POST",
      body: JSON.stringify({ event_type: "view_threshold_met", ad_id: "c1", campaign_id: "c1" }),
    });
    expect(r.ok).toBe(true);
    const events = calls.filter((c) => c.url.endsWith("/v1/events"));
    expect(events).toHaveLength(1);
    const body = JSON.parse(events[0].init!.body as string);
    expect(body).toMatchObject({ deviceId: "d1", deviceKey: "k1",
      events: [{ impressions: 1, clicks: 0 }] });
    expect(typeof body.batchKey).toBe("string");
  });

  it("non-billable events (impression_rendered, view_tick) hit no FreeAI endpoint", async () => {
    const { f, calls } = fakeServer({ "POST /v1/events": () => ok({ ok: true }) });
    const fetchT = createFreeAiFetch({ base: BASE,
      device: memStore({ deviceId: "d1", deviceKey: "k1" }), realFetch: f });
    for (const event_type of ["impression_rendered", "impression_viewable", "view_tick", "error_impression"]) {
      const r = await fetchT(`${BASE}/v1/metrics`, { method: "POST",
        body: JSON.stringify({ event_type, ad_id: "c1", campaign_id: "c1" }) });
      expect(r.ok).toBe(true);
    }
    expect(calls.filter((c) => c.url.endsWith("/v1/events"))).toHaveLength(0);
  });

  it("click requests a token then redeems the tracking url", async () => {
    const { f, calls } = fakeServer({
      "POST /v1/clicks/intent": () => ok({ trackingUrl: `${BASE}/v1/go/tok123` }),
      "GET /v1/go/tok123": () => new Response(null, { status: 302 }),
    });
    const fetchT = createFreeAiFetch({ base: BASE,
      device: memStore({ deviceId: "d1", deviceKey: "k1" }), realFetch: f });
    await fetchT(`${BASE}/v1/metrics`, { method: "POST",
      body: JSON.stringify({ event_type: "click", ad_id: "c1", campaign_id: "c1" }) });
    const intent = calls.find((c) => c.url.endsWith("/v1/clicks/intent"));
    expect(intent).toBeTruthy();
    expect(JSON.parse(intent!.init!.body as string)).toMatchObject({
      deviceId: "d1", deviceKey: "k1", campaignId: "c1" });
    expect(calls.some((c) => c.url.endsWith("/v1/go/tok123"))).toBe(true);
  });

  it("registers a device once (single-flight) and caches it", async () => {
    let registers = 0;
    const f = vi.fn(async (input: any, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      if (path === "/v1/devices/register") { registers++; return ok({ deviceId: "newD", deviceKey: "newK" }); }
      if (path === "/v1/events") return ok({ ok: true });
      return new Response("x", { status: 404 });
    }) as unknown as typeof fetch;
    const store = memStore();
    const fetchT = createFreeAiFetch({ base: BASE, device: store, realFetch: f });
    // Two concurrent billable events that both need identity.
    await Promise.all([
      fetchT(`${BASE}/v1/metrics`, { method: "POST",
        body: JSON.stringify({ event_type: "view_threshold_met", ad_id: "a", campaign_id: "a" }) }),
      fetchT(`${BASE}/v1/metrics`, { method: "POST",
        body: JSON.stringify({ event_type: "view_threshold_met", ad_id: "b", campaign_id: "b" }) }),
    ]);
    expect(registers).toBe(1);
    expect(await store.get()).toEqual({ deviceId: "newD", deviceKey: "newK" });
  });

  it("passes unmapped paths straight through to the real fetch", async () => {
    const { f, calls } = fakeServer({ "GET /v1/auth/extension/poll": () => ok({ pending: true }) });
    const fetchT = createFreeAiFetch({ base: BASE, device: memStore(), realFetch: f });
    const r = await fetchT(`${BASE}/v1/auth/extension/poll?state=s`);
    expect(await r.json()).toEqual({ pending: true });
    expect(calls.some((c) => c.url.includes("/v1/auth/extension/poll"))).toBe(true);
  });

  it("globalStateDeviceStore reads/writes the freeai.device key", async () => {
    const mem = new Map<string, unknown>();
    const gs = { get: <T>(k: string) => mem.get(k) as T | undefined,
      update: async (k: string, v: unknown) => { mem.set(k, v); } };
    const store = globalStateDeviceStore(gs);
    expect(await store.get()).toBeNull();
    await store.set({ deviceId: "d", deviceKey: "k" });
    expect(mem.get("freeai.device")).toEqual({ deviceId: "d", deviceKey: "k" });
    expect(await store.get()).toEqual({ deviceId: "d", deviceKey: "k" });
  });
});
