// FreeAI.fyi — Chrome extension verification harness.
// Loads the REAL content.js and background.js against a hand-rolled minimal DOM
// + chrome API mock, so the whole loop can be checked headlessly:
//   detection on ChatGPT / Claude / Gemini · Test Mode shows the mock ad ·
//   mock events never touch real earnings · the 50% math.
//
// Usage: node test/run.js   (or: npm test)

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

let pass = 0;
const check = (name, fn) => Promise.resolve(fn()).then(() => { pass++; console.log("  ✓ " + name); });

// ---------- a tiny DOM ----------
// Only as much as content.js touches. "Page" elements (for the detector) are
// registered via page.add(); the injected bar resolves its own child spans from
// the class names in the innerHTML string it's given.
function makeChild() {
  return { textContent: "", style: {} };
}
function parseChildren(html) {
  const map = {};
  const re = /class="([^"]+)"/g;
  let m;
  while ((m = re.exec(html))) {
    const cls = m[1].split(/\s+/)[0];
    map[cls] = makeChild();
  }
  return map;
}
function makeEl(tag) {
  let html = "";
  let kids = {};
  const set = new Set();
  return {
    tagName: String(tag).toUpperCase(),
    _attrs: {},
    style: {},
    isConnected: false,
    _click: null,
    classList: { add: (c) => set.add(c), remove: (c) => set.delete(c), contains: (c) => set.has(c) },
    appendChild(child) { child.isConnected = true; },
    setAttribute(k, v) { this._attrs[k] = v; },
    getAttribute(k) { return this._attrs[k]; },
    addEventListener(ev, fn) { if (ev === "click") this._click = fn; },
    set innerHTML(v) { html = v; kids = parseChildren(v); },
    get innerHTML() { return html; },
    querySelector(sel) { return kids[sel.replace(/^\./, "")] || null; },
    getBoundingClientRect() { return { width: 10, height: 10 }; },
  };
}

// page-level element registry + a minimal attribute/class selector matcher
const page = {
  els: [],
  add(tag, attrs = {}, classes = []) { this.els.push({ tag, attrs, classes }); return this; },
  clear() { this.els = []; return this; },
};
function matchOne(el, sel) {
  // tag prefix
  let rest = sel;
  const tagMatch = rest.match(/^([a-zA-Z]+)/);
  if (tagMatch) {
    if (el.tag.toLowerCase() !== tagMatch[1].toLowerCase()) return false;
    rest = rest.slice(tagMatch[1].length);
  }
  // .class
  const cls = rest.match(/^\.([\w-]+)$/);
  if (cls) return el.classes.includes(cls[1]);
  // [attr], [attr="v"], [attr*="v" i]
  const attr = rest.match(/^\[([\w-]+)(?:([*]?)=(['"])(.*?)\3(\s+i)?)?\]$/);
  if (attr) {
    const [, name, star, , val, ci] = attr;
    if (val === undefined) return name in el.attrs;
    const have = el.attrs[name];
    if (have === undefined) return false;
    if (star === "*") {
      return ci ? have.toLowerCase().includes(val.toLowerCase()) : have.includes(val);
    }
    return ci ? have.toLowerCase() === val.toLowerCase() : have === val;
  }
  return false;
}
const documentMock = {
  body: { appendChild: (child) => { child.isConnected = true; } },
  createElement: (tag) => makeEl(tag),
  querySelector: (sel) => (page.els.find((e) => matchOne(e, sel)) ? makeEl("x") : null),
  querySelectorAll: (sel) => page.els.filter((e) => matchOne(e, sel)).map(() => makeEl("button")),
};

// ---------- chrome mock ----------
function makeChrome(stateRef, sentRef) {
  return {
    runtime: {
      lastError: null,
      sendMessage: (msg, cb) => { sentRef.push(msg); cb && cb(stateRef.response(msg)); },
      onMessage: { addListener: () => {} },
      onInstalled: { addListener: () => {} },
    },
    storage: { local: { get: async () => ({}), set: async () => {} } },
    tabs: {},
  };
}

(async () => {
  console.log("freeai chrome-extension verification\n");

  // ---------- load ads.js into a shared global scope ----------
  const sandbox = {};
  sandbox.self = sandbox;
  sandbox.window = {};
  sandbox.document = documentMock;
  sandbox.setInterval = () => 0; // detector/loop driven manually in tests
  sandbox.clearInterval = () => {};
  sandbox.setTimeout = () => 0;
  const opened = [];
  sandbox.window.open = (url) => opened.push(url);

  const sent = [];
  const stateRef = {
    state: { enabled: true, testMode: false },
    response(msg) {
      if (msg.type === "BB_GET_STATE") return { ...this.state, mockAd: sandbox.BB_MOCK_AD };
      if (msg.type === "BB_GET_ADS") return sandbox.BB_ADS;
      return { ok: true };
    },
  };
  sandbox.chrome = makeChrome(stateRef, sent);

  const ctx = vm.createContext(sandbox);
  vm.runInContext(read("src/ads.js"), ctx);
  vm.runInContext(read("src/content.js"), ctx);

  const T = sandbox.window.__freeaiTest;

  await check("content script loads and injects the bar", () => {
    assert.ok(T, "test hook missing");
    assert.ok(T.bar, "bar not created");
  });

  await check("no generation signal ⇒ not thinking", () => {
    page.clear();
    T.setState({ enabled: true, testMode: false, ads: sandbox.BB_ADS });
    assert.strictEqual(T.isThinking(), false);
  });

  await check("detects ChatGPT stop button", () => {
    page.clear().add("button", { "data-testid": "stop-button" });
    assert.strictEqual(T.isThinking(), true);
  });

  await check("detects Claude stop button", () => {
    page.clear().add("button", { "aria-label": "Stop response" });
    assert.strictEqual(T.isThinking(), true);
  });

  await check("detects Gemini stop button (aria-label contains 'stop')", () => {
    page.clear().add("button", { "aria-label": "Stop generating response" });
    assert.strictEqual(T.isThinking(), true);
  });

  await check("detects a generic aria-busy region", () => {
    page.clear().add("div", { "aria-busy": "true" });
    assert.strictEqual(T.isThinking(), true);
  });

  await check("a sidebar title containing 'stop' does NOT count as thinking", () => {
    // ChatGPT regression: a conversation titled "6 Train Not Stopping" rendered
    // a visible button whose aria-label contained "stop", pinning the bar on.
    page.clear().add("button", { "aria-label": "Open conversation options for 6 Train Not Stopping" });
    assert.strictEqual(T.isThinking(), false, "matched a non-generation control");
  });

  await check("Test Mode without generation ⇒ bar stays hidden", () => {
    page.clear(); // nothing generating
    T.setState({ enabled: true, testMode: true, ads: sandbox.BB_ADS, mockAd: sandbox.BB_MOCK_AD });
    assert.strictEqual(T.isThinking(), false, "ad must only show while the model is thinking");
  });

  await check("Test Mode while generating ⇒ swaps in the mock ad", () => {
    page.add("button", { "data-testid": "stop-button" }); // model is thinking
    page.add("div", { "data-message-author-role": "assistant" }); // the reply area to anchor to
    assert.strictEqual(T.isThinking(), true, "mock ad should show while generating");
    const ad = T.currentAd();
    assert.ok(ad && ad.mock === true, "current ad is not the mock");
    assert.ok(/test/i.test(ad.line), "mock ad line should say 'test'");
  });

  await check("Test Mode renders the bar and tags it as a test", () => {
    T.evaluate();
    assert.ok(T.isActive(), "bar not active");
    assert.ok(T.bar.classList.contains("bb-show"), "bar not shown");
    assert.ok(T.bar.classList.contains("bb-test"), "bar not marked bb-test");
  });

  await check("a test-mode impression is tagged mock:true", () => {
    sent.length = 0;
    T.tick();
    const imp = sent.find((m) => m.type === "BB_IMPRESSION");
    assert.ok(imp, "no impression sent");
    assert.strictEqual(imp.mock, true, "test impression not tagged mock");
  });

  await check("only one ad is surfaced — the top of inventory, never rotating", () => {
    page.clear()
      .add("button", { "data-testid": "stop-button" })
      .add("div", { "data-message-author-role": "assistant" });
    const inventory = [
      { id: "ramp", chip: "R", line: "Ramp" },
      { id: "fluidstack", chip: "F", line: "FluidStack" },
      { id: "linear", chip: "L", line: "Linear" },
    ];
    T.setState({ enabled: true, testMode: false, ads: inventory });
    T.evaluate();
    assert.strictEqual(T.currentAd().id, "ramp", "not pinned to the top ad");
    for (let i = 0; i < 300; i++) T.tick(); // far past the old 2.6s rotation cadence
    assert.strictEqual(T.currentAd().id, "ramp", "the ad rotated — should stay put");
  });

  // ---------- background.js earnings vs mock ----------
  const bg = {};
  bg.self = bg;
  bg.importScripts = () => {}; // ads.js already provided below
  bg.BB_ADS = sandbox.BB_ADS;
  bg.BB_MOCK_AD = sandbox.BB_MOCK_AD;
  const store = {};
  bg.crypto = require("node:crypto"); // randomUUID for event batch keys
  bg.URL = URL; // service workers expose URL globally; the host guard uses it
  bg.chrome = {
    runtime: { onInstalled: { addListener: () => {} }, onMessage: { addListener: (fn) => { bg._onMessage = fn; } } },
    alarms: { create: () => {}, onAlarm: { addListener: () => {} } },
    storage: { local: {
      get: async (keys) => { const o = {}; (Array.isArray(keys) ? keys : [keys]).forEach((k) => { if (k in store) o[k] = store[k]; }); return o; },
      set: async (obj) => { Object.assign(store, obj); },
    } },
  };
  // Fake prod backend — records every call so the wiring can be asserted.
  const fetches = [];
  bg.fetch = async (url, options = {}) => {
    const u = String(url);
    fetches.push({ url: u, options });
    const ok = (body) => ({ ok: true, status: 200, json: async () => body });
    if (u.endsWith("/v1/devices/register")) return ok({ deviceId: "dev-1", deviceKey: "key-1" });
    if (u.endsWith("/v1/config")) return ok({ serving: true, revenueShare: 0.5 });
    if (u.endsWith("/v1/ads")) return ok({ revenueShare: 0.5, ads: [] });
    if (u.endsWith("/v1/events")) return ok({ ok: true, creditedMillicents: 0 });
    // Return an UNDECLARED third-party tracking host; the SW must refuse to fetch it.
    if (u.endsWith("/v1/clicks/intent")) return ok({ trackingUrl: "https://tracker.example.com/go/tok123" });
    if (u.includes("/v1/go/") || u.includes("tracker.example.com")) return ok({});
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const bgCtx = vm.createContext(bg);
  vm.runInContext(read("src/background.js"), bgCtx);
  const msg = (m) => new Promise((res) => bg._onMessage(m, {}, res));
  // Drain the fire-and-forget network side effects (register/flush/click report).
  const settle = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 1)); };

  await check("real impression earns 50% of the per-impression gross", async () => {
    const s = await msg({ type: "BB_IMPRESSION", mock: false });
    assert.strictEqual(s.impressions, 1);
    assert.ok(Math.abs(s.earnings - (12 / 1000) * 0.5) < 1e-9, "earnings != 50% share");
  });

  await check("real click pays 50× an impression", async () => {
    const before = (await msg({ type: "BB_GET_STATE" })).earnings;
    const s = await msg({ type: "BB_CLICK", mock: false });
    assert.strictEqual(s.clicks, 1);
    assert.ok(Math.abs(s.earnings - before - (12 / 1000) * 0.5 * 50) < 1e-9, "click != 50×");
  });

  await check("mock impression/click never touch real earnings", async () => {
    const before = await msg({ type: "BB_GET_STATE" });
    await msg({ type: "BB_IMPRESSION", mock: true });
    await msg({ type: "BB_CLICK", mock: true });
    const after = await msg({ type: "BB_GET_STATE" });
    assert.strictEqual(after.earnings, before.earnings, "mock event changed real earnings");
    assert.strictEqual(after.impressions, before.impressions, "mock changed real impressions");
    assert.strictEqual(after.testImpressions, 1, "test impression not counted");
    assert.strictEqual(after.testClicks, 1, "test click not counted");
  });

  await check("reset zeroes both real and test counters", async () => {
    const s = await msg({ type: "BB_RESET" });
    assert.strictEqual(s.impressions, 0);
    assert.strictEqual(s.earnings, 0);
    assert.strictEqual(s.testImpressions, 0);
    assert.strictEqual(s.testClicks, 0);
  });

  // ---------- prod backend wiring ----------
  await settle(); // let earlier fire-and-forget flushes finish

  await check("a real impression registers a device and is persisted", async () => {
    assert.ok(store.deviceId && store.deviceKey, "device credentials not persisted");
    assert.ok(fetches.some((f) => f.url.endsWith("/v1/devices/register")), "never registered a device");
  });

  await check("BB_GET_ADS prefers cached live inventory over the bundled list", async () => {
    store.liveAds = [
      { id: "c1", brand: "Acme", chip: "A", color: "#111", ink: "#fff", line: "Acme — live ad", url: "https://acme.example", cat: "devtools" },
    ];
    const ads = await msg({ type: "BB_GET_ADS" });
    assert.ok(Array.isArray(ads) && ads.length === 1, "did not return the live list");
    assert.strictEqual(ads[0].line, "Acme — live ad");
  });

  await check("a real impression reports to the prod ledger with a batch key", async () => {
    store.pendingImpressions = 0;
    fetches.length = 0;
    await msg({ type: "BB_IMPRESSION", mock: false });
    await settle();
    const ev = fetches.find((f) => f.url.endsWith("/v1/events"));
    assert.ok(ev, "no /v1/events POST");
    const body = JSON.parse(ev.options.body);
    assert.ok(body.batchKey, "missing idempotency batchKey");
    assert.ok(body.events[0].impressions >= 1, "impressions not reported");
    assert.strictEqual(body.deviceId, "dev-1", "events not authed with the device");
  });

  await check("mock impressions and clicks never reach the network", async () => {
    fetches.length = 0;
    await msg({ type: "BB_IMPRESSION", mock: true });
    await msg({ type: "BB_CLICK", mock: true });
    await settle();
    assert.ok(!fetches.some((f) => f.url.endsWith("/v1/events")), "mock impression hit the ledger");
    assert.ok(!fetches.some((f) => f.url.endsWith("/v1/clicks/intent")), "mock click requested a token");
  });

  await check("a live-ad click records via a first-party token and never fetches an undeclared host", async () => {
    fetches.length = 0;
    await msg({ type: "BB_CLICK", mock: false, campaignId: "c1" });
    await settle();
    const intent = fetches.find((f) => f.url.endsWith("/v1/clicks/intent"));
    assert.ok(intent, "no /v1/clicks/intent POST"); // click recorded on our own backend
    assert.strictEqual(JSON.parse(intent.options.body).campaignId, "c1");
    // the server returned a third-party trackingUrl; the SW must NOT request it
    // (only declared hosts — freeai.fyi / *.supabase.co — may be fetched).
    assert.ok(!fetches.some((f) => f.url.includes("tracker.example.com")), "fetched an UNDECLARED tracking host");
  });

  console.log(`\nall ${pass} checks passed — detection, test mode, the 50% split, and prod wiring verified.`);
})().catch((err) => {
  console.error("\n✗ FAILED:", err.stack || err.message);
  process.exit(1);
});
