// Betterbacks — verification harness.
// Runs extension.js against a mock `vscode` module so the whole flow can be
// verified headlessly: activate → simulate an agent run → impressions accrue
// at the 90% share → a click pays 50× → dashboard renders.
//
// Usage: node test/run.js   (or: npm test)

const assert = require("assert");
const path = require("path");
const Module = require("module");

// ---------- mock vscode ----------
const config = new Map([
  ["enabled", true],
  ["revenueShare", 0.9],
  ["grossCpm", 12],
  ["blockedCategories", []],
  ["autoShowOnTerminal", true],
]);

const statusBar = {
  text: "",
  tooltip: null,
  command: null,
  color: undefined,
  shown: false,
  show() { this.shown = true; },
  hide() { this.shown = false; },
  dispose() {},
};

const commands = new Map();
const openedUrls = [];
const infoMessages = [];
let webviewHtml = null;

const windowStateListeners = [];
function setFocused(v) {
  vscodeMock.window.state.focused = v;
  windowStateListeners.forEach((fn) => fn({ focused: v }));
}

const vscodeMock = {
  window: {
    state: { focused: true },
    onDidChangeWindowState: (fn) => { windowStateListeners.push(fn); return { dispose() {} }; },
    createStatusBarItem: () => statusBar,
    showInformationMessage: (m) => { infoMessages.push(m); },
    createWebviewPanel: () => ({
      webview: {
        set html(v) { webviewHtml = v; },
        get html() { return webviewHtml; },
      },
    }),
    onDidChangeActiveTerminal: () => ({ dispose() {} }),
    onDidCloseTerminal: () => ({ dispose() {} }),
    activeTerminal: undefined,
    StatusBarAlignment: { Left: 1, Right: 2 },
  },
  StatusBarAlignment: { Left: 1, Right: 2 },
  ThemeColor: class ThemeColor { constructor(id) { this.id = id; } },
  MarkdownString: class MarkdownString { constructor(v) { this.value = v; } },
  ViewColumn: { Active: -1 },
  ConfigurationTarget: { Global: 1 },
  workspace: {
    getConfiguration: () => ({
      get: (k, d) => (config.has(k) ? config.get(k) : d),
      update: async (k, v) => { config.set(k, v); },
    }),
  },
  commands: {
    registerCommand: (id, fn) => { commands.set(id, fn); return { dispose() {} }; },
  },
  env: {
    openExternal: async (uri) => { openedUrls.push(String(uri)); return true; },
  },
  Uri: { parse: (s) => s },
};

// intercept require("vscode")
const realResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === "vscode") return "vscode";
  return realResolve.call(this, request, ...rest);
};
require.cache["vscode"] = { id: "vscode", filename: "vscode", loaded: true, exports: vscodeMock };

// ---------- fake timers ----------
// extension.js drives everything off setInterval/setTimeout; capture them so the
// test can advance "time" deterministically instead of sleeping for real.
const intervals = [];
const realSetInterval = global.setInterval;
const realClearInterval = global.clearInterval;
global.setInterval = (fn, ms) => {
  const h = { fn, ms, cleared: false };
  intervals.push(h);
  return h;
};
global.clearInterval = (h) => { if (h && typeof h === "object") h.cleared = true; };
const timeouts = [];
global.setTimeout = (fn, ms) => { timeouts.push({ fn, ms }); return timeouts.length; };

function advance(ms) {
  // fire each live interval as many times as it would have in `ms`
  for (const h of intervals) {
    if (h.cleared) continue;
    const times = Math.floor(ms / h.ms);
    for (let i = 0; i < times; i++) h.fn();
  }
}

// ---------- in-memory globalState + SecretStorage ----------
const store = new Map();
const secretStore = new Map();
const context = {
  globalState: {
    get: (k, d) => (store.has(k) ? store.get(k) : d),
    update: async (k, v) => { v === undefined ? store.delete(k) : store.set(k, v); },
  },
  secrets: {
    get: async (k) => secretStore.get(k),
    store: async (k, v) => { secretStore.set(k, v); },
    delete: async (k) => { secretStore.delete(k); },
  },
  subscriptions: [],
};

// ---------- fetch spy (server mode) ----------
const fetchCalls = [];
let configServing = true; // flipped by the killswitch test
global.fetch = async (url, opts = {}) => {
  fetchCalls.push({ url, opts });
  if (url.endsWith("/v1/config"))
    return { ok: true, json: async () => ({ serving: configServing, revenueShare: 0.9 }) };
  if (url.endsWith("/v1/devices/register"))
    return { ok: true, json: async () => ({ deviceId: "dev-1", deviceKey: "key-1" }) };
  if (url.endsWith("/v1/ads"))
    return {
      ok: true,
      json: async () => ({
        revenueShare: 0.9,
        ads: [{ id: "c1", brand: "TestCo", line: "TESTAD — served from the live auction", url: "https://t.co", cat: "devtools" }],
      }),
    };
  if (url.endsWith("/v1/events")) return { ok: true, json: async () => ({ ok: true }) };
  return { ok: false, json: async () => ({}) };
};

// ---------- run ----------
const ext = require(path.join(__dirname, "..", "extension.js"));
let pass = 0;
const check = (name, fn) => {
  const done = () => { pass++; console.log("  ✓ " + name); };
  const r = fn();
  if (r && typeof r.then === "function") return r.then(done);
  done();
};

console.log("betterbacks verification\n");

check("activates and registers all 5 commands", () => {
  ext.activate(context);
  for (const id of [
    "betterbacks.toggle",
    "betterbacks.simulateAgent",
    "betterbacks.showEarnings",
    "betterbacks.openCurrentAd",
    "betterbacks.resetEarnings",
  ]) assert.ok(commands.has(id), "missing command: " + id);
});

check("idle status bar shows brand + $0.00 and is visible", () => {
  assert.ok(statusBar.shown, "status bar not shown");
  assert.ok(statusBar.text.includes("betterbacks"), "no brand in: " + statusBar.text);
  assert.ok(statusBar.text.includes("$0.00"), "expected $0.00 in: " + statusBar.text);
});

check("simulated agent run serves a sponsored line in the spinner", () => {
  commands.get("betterbacks.simulateAgent")();
  advance(200); // a couple of animation frames
  assert.ok(/[✳✶✷✸✹✺]/.test(statusBar.text), "no spinner glyph in: " + statusBar.text);
  assert.ok(statusBar.text.includes("·"), "no sponsored separator in: " + statusBar.text);
  assert.ok(statusBar.text.length > 20, "line suspiciously short: " + statusBar.text);
});

check("impressions accrue at exactly the 90% share", () => {
  // initial impression on start + 6 more over 30s of waiting
  advance(30000);
  const imp = store.get("bb.impressions");
  const earn = store.get("bb.earnings");
  assert.strictEqual(imp, 7, "expected 7 impressions, got " + imp);
  // per impression: (grossCpm 12 / 1000) * 0.9 = $0.0108
  const expected = 7 * (12 / 1000) * 0.9;
  assert.ok(Math.abs(earn - expected) < 1e-9, `earnings ${earn} != ${expected}`);
});

check("unfocused window earns nothing (viewability)", () => {
  setFocused(false);
  advance(10000); // two impression ticks while blurred
  assert.strictEqual(store.get("bb.impressions"), 7, "blurred ticks were paid");
  setFocused(true);
});

check("a click opens the ad URL and pays 50× an impression", () => {
  const before = store.get("bb.earnings");
  commands.get("betterbacks.openCurrentAd")();
  assert.strictEqual(openedUrls.length, 1, "ad URL not opened");
  assert.ok(openedUrls[0].startsWith("https://betterbacks.ai/go/"), openedUrls[0]);
  const gained = store.get("bb.earnings") - before;
  const expected = (12 / 1000) * 0.9 * 50;
  assert.ok(Math.abs(gained - expected) < 1e-9, `click paid ${gained}, expected ${expected}`);
  assert.strictEqual(store.get("bb.clicks"), 1);
});

check("earnings dashboard renders the 90% split and the bid market", () => {
  commands.get("betterbacks.showEarnings")();
  assert.ok(webviewHtml.includes("You keep 90%"), "dashboard missing 90% headline");
  assert.ok(webviewHtml.includes("Live bid market"), "dashboard missing bid market");
  assert.ok(webviewHtml.includes("Fluidstack"), "dashboard missing top bidder");
});

check("blocked categories are never served", () => {
  config.set("blockedCategories", ["finance"]);
  commands.get("betterbacks.showEarnings")();
  assert.ok(!webviewHtml.includes("Ramp"), "blocked 'finance' ad (Ramp) still served");
  config.set("blockedCategories", []);
});

(async () => {
  const tickAsync = () => new Promise((r) => setImmediate(r));

  check("server mode stays off without a serverUrl (no network calls)", () => {
    assert.strictEqual(fetchCalls.length, 0, "unexpected fetches: " + JSON.stringify(fetchCalls.map((c) => c.url)));
  });

  // flip on server mode and re-activate
  config.set("serverUrl", "http://api.fake");
  ext.activate(context);
  await tickAsync();
  await tickAsync();

  check("server mode registers the device and pulls live auction ads", () => {
    const urls = fetchCalls.map((c) => c.url);
    assert.ok(urls.includes("http://api.fake/v1/devices/register"), "no device registration");
    assert.ok(urls.includes("http://api.fake/v1/ads"), "ads not fetched");
    assert.ok(urls.includes("http://api.fake/v1/config"), "killswitch config not checked");
  });

  check("device credentials live in SecretStorage, not globalState", () => {
    assert.deepStrictEqual(JSON.parse(secretStore.get("bb.device")), { deviceId: "dev-1", deviceKey: "key-1" });
    assert.strictEqual(store.get("bb.device"), undefined, "deviceKey leaked into globalState");
  });

  check("live auction ad serves in the spinner", () => {
    commands.get("betterbacks.simulateAgent")();
    advance(200);
    assert.ok(statusBar.text.includes("TESTAD"), "live ad not serving: " + statusBar.text);
  });

  await check("impressions batch to POST /v1/events with device credentials", async () => {
    advance(60000); // accrue impressions, then the 60s flush fires
    await tickAsync();
    const post = fetchCalls.find((c) => c.url === "http://api.fake/v1/events");
    assert.ok(post, "no events batch posted");
    const body = JSON.parse(post.opts.body);
    assert.strictEqual(body.deviceId, "dev-1");
    assert.ok(body.batchKey, "missing idempotency batchKey");
    assert.ok(body.events.length === 1 && body.events[0].campaignId === "c1", JSON.stringify(body.events));
    assert.ok(body.events[0].impressions > 0, "no impressions in batch");
  });

  await check("server killswitch stops serving and blocks new runs", async () => {
    configServing = false;
    advance(300000); // the 5-minute killswitch poll fires
    await tickAsync();
    await tickAsync();
    assert.ok(statusBar.text.includes("betterbacks"), "not idle after killswitch: " + statusBar.text);
    commands.get("betterbacks.simulateAgent")();
    advance(200);
    assert.ok(!/[✳✶✷✸✹✺]/.test(statusBar.text), "served while killed: " + statusBar.text);
    configServing = true;
  });

  // the reset command awaits globalState updates, so await it before asserting
  await commands.get("betterbacks.resetEarnings")();
  check("reset zeroes the counters", () => {
    assert.strictEqual(store.get("bb.impressions"), 0);
    assert.strictEqual(store.get("bb.earnings"), 0);
  });

  console.log(`\nall ${pass} checks passed — the spinner pays 90%. 🤑`);
})();
