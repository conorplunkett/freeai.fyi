// FreeAI.fyi — content script
// Detects when the AI assistant on this page is "thinking"/streaming, and shows
// ONE subtle, clickable sponsored line near the composer. 50% back as Claude credits.
//
// Works on the three sites our ICP lives in — ChatGPT, Claude, and Google
// (Gemini / AI Studio) — plus a few more, via layered detection:
//   1) site-specific "stop generating" controls (most reliable)
//   2) a generic visible Stop button (aria-label contains "stop")
//   3) aria-busy live regions / known streaming class markers
//
// Test Mode (toggled from the popup) shows a clearly-labelled MOCK ad at all
// times on a supported page, so the whole thing can be verified without waiting
// for the model to actually generate.
(function () {
  if (window.__freeaiLoaded) return;
  window.__freeaiLoaded = true;

  // Site-specific "the model is generating" controls. Each is the Stop button
  // that only exists while a response streams. Kept broad + case-insensitive so
  // small UI revisions don't silently break detection.
  const STOP_SELECTORS = [
    'button[data-testid="stop-button"]',            // ChatGPT
    'button[data-testid="stop-streaming"]',         // ChatGPT (older)
    'button[aria-label="Stop response"]',           // Claude
    'button[aria-label*="stop generating" i]',      // ChatGPT / generic
    'button[aria-label*="stop streaming" i]',       // generic
    'button[aria-label*="stop" i]',                 // Gemini + catch-all
    'button[mattooltip*="stop" i]',                 // Gemini (Angular Material)
  ];
  const BUSY_SELECTORS = [
    '[aria-busy="true"]',
    ".result-streaming",
    "[data-is-streaming='true']",
    ".streaming-animation",
    ".thinking-dots-animation",    // Gemini — the ··· lottie before the reply renders
    "thinking-dots-animation",     // Gemini — the custom-element wrapper
    '[class*="thinking-dots"]',    // catch-all for either
  ];

  // Where to put the bar, in priority order. "inside" appends at the end of
  // the matched element; "after" drops the bar at the end of the element's
  // PARENT — used where the thinking indicator is a later sibling of the
  // matched turn (Claude's star-only stage, Gemini's dots), so the bar always
  // lands BELOW the indicator, never above it.
  const ANCHORS = [
    { sel: '[data-is-streaming="true"]', mode: "inside" },             // Claude — streaming bubble
    { sel: "div[data-test-render-count]", mode: "after" },             // Claude — star-only stage
    { sel: '[data-message-author-role="assistant"]', mode: "inside" }, // ChatGPT
    { sel: ".result-streaming", mode: "inside" },                      // ChatGPT (older)
    // Gemini: the dots stage MUST outrank model-response — an empty
    // model-response shell exists while the dots are showing, and anchoring
    // inside it puts the bar above the dots.
    { sel: "thinking-dots-animation", mode: "after" },                 // Gemini — dots stage
    { sel: ".thinking-dots-animation", mode: "after" },
    { sel: '[class*="thinking-dots"]', mode: "after" },
    { sel: "model-response", mode: "inside" },                         // Gemini — reply
  ];

  let ads = [];
  let mockAd = (typeof self !== "undefined" && self.BB_MOCK_AD) || null;
  let enabled = true;
  let testMode = false;
  let active = false;
  let demoUntil = 0;
  let adIdx = 0;
  let lastImpressionAt = 0;

  // ---------- safe messaging (service worker may be asleep / context torn down) ----------
  function send(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (resp) => {
          void chrome.runtime.lastError; // swallow
          resolve(resp);
        });
      } catch (_) {
        resolve(null);
      }
    });
  }

  // ---------- build the injected sponsored bar ----------
  const bar = document.createElement("div");
  bar.className = "bb-bar";
  bar.setAttribute("role", "complementary");
  bar.innerHTML =
    '<span class="bb-chip">R</span>' +
    '<span class="bb-line">Ramp · save time and money</span>' +
    '<span class="bb-tag">sponsored · 50% back as Claude credits</span>';
  const elChip = bar.querySelector(".bb-chip");
  const elLine = bar.querySelector(".bb-line");
  const elTag = bar.querySelector(".bb-tag");

  // The ad currently on screen — mock while in Test Mode, otherwise live inventory.
  function currentAd() {
    if (testMode) return mockAd || (ads.length ? ads[0] : null);
    return ads.length ? ads[adIdx % ads.length] : null;
  }

  bar.addEventListener("click", async () => {
    const ad = currentAd();
    if (!ad) return;
    await send({ type: "BB_CLICK", mock: !!ad.mock });
    window.open(ad.url, "_blank", "noopener");
  });

  // Attach the bar inline at the streaming reply. If no anchor exists yet the
  // bar stays HIDDEN — it must never flash at the bottom of the page before
  // the reply area appears. (The fixed bottom pill survives only for the
  // popup's 30s demo, which runs without any generation.) Re-checked every
  // tick because these apps re-render aggressively (React may evict us) and
  // the anchor often appears a beat after the Stop button.
  let anchorEl = null;
  function findAnchor() {
    for (const { sel, mode } of ANCHORS) {
      try {
        const els = document.querySelectorAll(sel);
        if (els.length) return { el: els[els.length - 1], mode };
      } catch (_) {}
    }
    return null;
  }
  // Returns true when the bar has somewhere legitimate to live.
  function mount() {
    const found = findAnchor();
    if (found) {
      // "after": the indicator (Claude star / Gemini dots) is a later sibling
      // of the matched turn — append to the parent so the bar sits below it.
      let target = found.el;
      if (found.mode === "after" && target.parentElement) target = target.parentElement;
      if (typeof target.appendChild === "function") {
        // These apps keep inserting elements (the star, the dots, streamed
        // text) AFTER we've mounted, which leaves the bar sitting above the
        // thinking indicator. So: whenever the bar isn't the LAST element of
        // its anchor, re-append it to push it back below everything.
        const isLast =
          bar.isConnected && bar.parentElement === target && target.lastElementChild === bar;
        if (isLast) return true;
        anchorEl = target;
        bar.classList.add("bb-inline");
        try {
          target.appendChild(bar);
          return true;
        } catch (_) {}
      }
    }
    anchorEl = null;
    if (Date.now() < demoUntil) {
      // demo only: fixed pill above the composer (no reply area to anchor to)
      bar.classList.remove("bb-inline");
      if (!bar.isConnected && document.body) document.body.appendChild(bar);
      return true;
    }
    return false; // thinking, but the reply area isn't in the DOM yet — stay hidden
  }

  // ---------- render ----------
  function render() {
    const ad = currentAd();
    if (ad) {
      elChip.textContent = ad.chip;
      elChip.style.background = ad.color;
      elChip.style.color = ad.ink;
      elLine.textContent = ad.line;
    }
    if (testMode) {
      elTag.textContent = "TEST AD · mock";
      bar.classList.add("bb-test");
    } else {
      elTag.textContent = "sponsored · 50% back as Claude credits";
      bar.classList.remove("bb-test");
    }
  }

  // ---------- generation detector ----------
  function isVisible(el) {
    if (!el) return false;
    if (typeof el.getBoundingClientRect !== "function") return true; // test/mock DOM
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }
  function isThinking() {
    // NB: Test Mode no longer forces the bar on — it swaps in the mock ad, but
    // the bar still only shows while the model is actually generating.
    if (Date.now() < demoUntil) return true;
    for (const sel of STOP_SELECTORS) {
      const els = document.querySelectorAll(sel);
      for (const el of els) if (isVisible(el)) return true;
    }
    for (const sel of BUSY_SELECTORS) {
      if (document.querySelector(sel)) return true;
    }
    return false;
  }

  // ---------- main loop ----------
  let spinTimer = null;
  function startActive() {
    if (active) return;
    active = true;
    adIdx = Math.floor(Math.random() * (ads.length || 1));
    if (mount()) bar.classList.add("bb-show"); // else: tick() shows it once the reply area exists
    render();
    lastImpressionAt = 0;
    spinTimer = setInterval(tick, 100);
  }
  function stopActive() {
    if (!active) return;
    active = false;
    bar.classList.remove("bb-show");
    if (spinTimer) clearInterval(spinTimer);
    spinTimer = null;
  }
  let frameCount = 0;
  function tick() {
    // keep the bar pinned to the streaming reply across re-renders; show only
    // once an anchor exists so it never starts at the bottom of the page
    if (mount()) bar.classList.add("bb-show");
    else bar.classList.remove("bb-show");
    render();
    frameCount++;
    // rotate the ad roughly every 2.6s (skip rotation while testing — the
    // mock ad should stay put so it's easy to inspect)
    if (!testMode && frameCount % 26 === 0) {
      adIdx++;
    }
    // one impression every 5s of serving — only while actually visible
    if (!bar.classList.contains("bb-show")) return;
    const now = Date.now();
    if (now - lastImpressionAt >= 5000) {
      lastImpressionAt = now;
      send({ type: "BB_IMPRESSION", mock: testMode });
    }
  }

  function evaluate() {
    if (!enabled) {
      stopActive();
      return;
    }
    if (isThinking()) startActive();
    else stopActive();
  }

  // poll the page state ~3x/sec (cheap; observers on these apps are noisy)
  const pollTimer = setInterval(evaluate, 350);

  // ---------- messages from the popup ----------
  chrome.runtime.onMessage.addListener((msg, _s, resp) => {
    if (msg.type === "BB_DEMO") {
      demoUntil = Date.now() + (msg.ms || 30000);
      resp && resp({ ok: true });
    }
    if (msg.type === "BB_REFRESH") {
      bootstrap().then(() => evaluate());
      resp && resp({ ok: true });
    }
  });

  // ---------- bootstrap ----------
  async function bootstrap() {
    const state = await send({ type: "BB_GET_STATE" });
    enabled = state ? state.enabled !== false : true;
    testMode = state ? !!state.testMode : false;
    ads = (await send({ type: "BB_GET_ADS" })) || self.BB_ADS || [];
    if (state && state.mockAd) mockAd = state.mockAd;
    evaluate();
  }
  bootstrap();

  // ---------- test hook (used by the headless harness; harmless in prod) ----------
  window.__freeaiTest = {
    isThinking,
    evaluate,
    tick,
    bar,
    isActive: () => active,
    currentAd,
    setState: (s) => {
      enabled = s.enabled !== false;
      testMode = !!s.testMode;
      if (Array.isArray(s.ads)) ads = s.ads;
      if (s.mockAd) mockAd = s.mockAd;
    },
    _stopTimers: () => {
      clearInterval(pollTimer);
      if (spinTimer) clearInterval(spinTimer);
    },
  };
})();
