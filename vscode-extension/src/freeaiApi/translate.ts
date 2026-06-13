// FreeAI backend adapter ("Option A" — see ../../INTEGRATION.md).
//
// The extension's HTTP clients (PortfolioClient, MetricsClient, KillSwitchClient)
// speak the upstream "S2" contract: GET /v1/portfolio, POST /v1/metrics,
// GET /v1/killswitch. The FreeAI production server (server/src/app.js) speaks a
// DIFFERENT, simpler device-key contract that the Chrome extension already uses:
// GET /v1/ads, POST /v1/events, POST /v1/clicks/intent, GET /v1/config,
// POST /v1/devices/register.
//
// Rather than rewrite (and re-test) every client, we adapt at the ONE seam they
// all share: the injectable `f: Fetch`. `createFreeAiFetch()` returns a function
// with the exact `fetch` signature that intercepts the S2 paths, calls the real
// FreeAI endpoints, and synthesizes S2-shaped responses. Unmapped paths pass
// straight through. This keeps the clients — and their whole test suite —
// untouched, and is itself unit-tested in test/freeaiApi.test.ts.
//
// Identity model: FreeAI credits an anonymous *device* (deviceId + deviceKey
// from /v1/devices/register), exactly like the Chrome extension — no sign-in is
// required to earn. So both the "authed" and signed-out/"demo" S2 paths map to
// the same real, device-credited FreeAI calls.

import { randomUUID } from "node:crypto";
import { timeoutFetch } from "../util/http";

type Fetch = typeof fetch;

export interface Device { deviceId: string; deviceKey: string; }

/** Persistent home for the anonymous device identity (back it with VS Code
 *  globalState in production, or a plain object in tests). */
export interface DeviceStore {
  get(): Promise<Device | null>;
  set(d: Device): Promise<void>;
}

export interface FreeAiFetchOpts {
  /** FreeAI API base, e.g. https://api.freeai.fyi */
  base: string;
  /** Persistent device identity. */
  device: DeviceStore;
  /** The real network fetch (defaults to the timeout-wrapped global). */
  realFetch?: Fetch;
}

// How FreeAI's "5 seconds served = 1 impression" maps onto the client's
// view-threshold timer: an ad that stays visible this long bills one impression.
const VIEW_THRESHOLD_SECONDS = 5;
const ROTATION_INTERVAL_SECONDS = 30;
const PORTFOLIO_TTL_SECONDS = 120;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function urlOf(input: RequestInfo | URL): URL | null {
  try {
    const s = typeof input === "string" ? input
      : input instanceof URL ? input.toString()
      : (input as Request).url;
    return new URL(s);
  } catch {
    return null;
  }
}

function parseBody(init?: RequestInit): Record<string, unknown> {
  try {
    if (init && typeof init.body === "string") return JSON.parse(init.body);
  } catch { /* not JSON */ }
  return {};
}

/** Build a translating fetch. Pure + side-effect-free until called. */
export function createFreeAiFetch(opts: FreeAiFetchOpts): Fetch {
  const base = opts.base.replace(/\/+$/, "");
  const realFetch: Fetch = opts.realFetch ?? timeoutFetch(15000);
  // Single-flight device registration so concurrent first-calls (portfolio +
  // killswitch fire together at activation) never register two devices.
  let regInFlight: Promise<Device | null> | null = null;

  async function ensureDevice(): Promise<Device | null> {
    const cached = await opts.device.get();
    if (cached?.deviceId && cached?.deviceKey) return cached;
    if (!regInFlight) {
      regInFlight = (async () => {
        try {
          const r = await realFetch(`${base}/v1/devices/register`, { method: "POST" });
          if (!r.ok) return null;
          const j = await r.json() as Partial<Device>;
          if (j.deviceId && j.deviceKey) {
            const d = { deviceId: j.deviceId, deviceKey: j.deviceKey };
            await opts.device.set(d);
            return d;
          }
          return null;
        } catch {
          return null;
        } finally {
          regInFlight = null;
        }
      })();
    }
    return regInFlight;
  }

  async function getConfig(): Promise<{ serving: boolean; revenueShare?: number }> {
    try {
      const r = await realFetch(`${base}/v1/config`);
      if (!r.ok) return { serving: true };
      const j = await r.json() as { serving?: boolean; revenueShare?: number };
      return { serving: j.serving !== false, revenueShare: j.revenueShare };
    } catch {
      // Reachability failure: let the caller's own fail-safe posture decide.
      throw new Error("config unreachable");
    }
  }

  // ── S2 /v1/portfolio[/demo] → FreeAI /v1/ads ──────────────────────────────
  async function portfolio(): Promise<Response> {
    try {
      const r = await realFetch(`${base}/v1/ads`);
      if (!r.ok) return jsonResponse(502, { error: "ads upstream" });
      const j = await r.json() as {
        ads?: { id: string; brand?: string; line?: string; url?: string; cat?: string }[];
      };
      const ads = (j.ads || []).map((a) => ({
        ad_id: a.id,
        // FreeAI's ad id *is* the campaign id for /v1/clicks/intent.
        campaign_id: a.id,
        title_text: a.line || a.brand || "",
        icon_ref: "",
        icon_url: "",
        click_url: a.url || "",
        banner_enabled: false,
        session_token: "",
      }));
      return jsonResponse(200, {
        ttl_seconds: PORTFOLIO_TTL_SECONDS,
        view_threshold_seconds: VIEW_THRESHOLD_SECONDS,
        rotation_interval_seconds: ROTATION_INTERVAL_SECONDS,
        queue_id: "",
        ads,
        // Earnings display requires a signed-in account; omitted in the
        // device-only v1 (the status bar renders $0.00). See INTEGRATION.md.
        balances: null,
      });
    } catch {
      return jsonResponse(502, { error: "ads unreachable" });
    }
  }

  // ── S2 /v1/killswitch → FreeAI /v1/config (serving flag) ──────────────────
  async function killswitch(): Promise<Response> {
    try {
      const cfg = await getConfig();
      return jsonResponse(200, { killed: !cfg.serving });
    } catch {
      // Unreachable: surface a non-2xx so KillSwitchClient takes its offline
      // (fail-safe-killed, unconfirmed) branch rather than confirming a kill.
      return jsonResponse(503, { error: "config unreachable" });
    }
  }

  // ── S2 /v1/metrics[/demo] → FreeAI /v1/events + /v1/clicks/intent ──────────
  async function metrics(init?: RequestInit): Promise<Response> {
    const ev = parseBody(init);
    const eventType = String(ev.event_type || "");
    const campaignId = String(ev.campaign_id || ev.ad_id || "");
    try {
      if (eventType === "view_threshold_met") {
        // The one billable "the ad was actually on screen long enough" event →
        // one FreeAI impression.
        const device = await ensureDevice();
        if (device) {
          await realFetch(`${base}/v1/events`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              deviceId: device.deviceId,
              deviceKey: device.deviceKey,
              batchKey: randomUUID(),
              events: [{ impressions: 1, clicks: 0 }],
            }),
          });
        }
      } else if (eventType === "click" && campaignId) {
        // Forgery-proof click: ask for a single-use token, then redeem it so the
        // click is recorded server-side (the user's own navigation is separate).
        const device = await ensureDevice();
        if (device) {
          const r = await realFetch(`${base}/v1/clicks/intent`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              deviceId: device.deviceId,
              deviceKey: device.deviceKey,
              campaignId,
            }),
          });
          if (r.ok) {
            try {
              const { trackingUrl } = await r.json() as { trackingUrl?: string };
              if (trackingUrl) await realFetch(trackingUrl, { redirect: "manual" });
            } catch { /* best-effort redeem */ }
          }
        }
      }
      // impression_rendered / impression_viewable / prompt_view / view_tick /
      // error_impression have no FreeAI equivalent — accept and drop.
    } catch { /* telemetry is best-effort; never surface a failure */ }
    // Always a clean 2xx with an empty body: the client reads it only for
    // optional fleet signals (kill/balances), which we don't piggyback here.
    return jsonResponse(200, {});
  }

  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const u = urlOf(input);
    const path = u?.pathname ?? "";
    if (path === "/v1/portfolio" || path === "/v1/portfolio/demo") return portfolio();
    if (path === "/v1/killswitch") return killswitch();
    if (path === "/v1/metrics" || path === "/v1/metrics/demo") return metrics(init);
    // Unmapped (auth, consent, earnings, self-update manifest): pass through so
    // future FreeAI endpoints "just work". They 404 today and the clients —
    // all best-effort — degrade gracefully (signed-out, $0.00 earnings).
    return realFetch(input as Parameters<Fetch>[0], init);
  }) as Fetch;
}

/** VS Code-backed device store (globalState). Kept out of translate() so the
 *  core stays free of vscode imports and trivially unit-testable. */
export function globalStateDeviceStore(globalState: {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void> | Promise<void>;
}): DeviceStore {
  const KEY = "freeai.device";
  return {
    async get() {
      const d = globalState.get<Device>(KEY);
      return d?.deviceId && d?.deviceKey ? d : null;
    },
    async set(d) { await globalState.update(KEY, d); },
  };
}
