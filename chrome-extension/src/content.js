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
  // Each must denote a stop-GENERATION control, never an arbitrary element
  // whose label merely contains "stop". A bare aria-label*="stop" catch-all
  // matched ChatGPT sidebar conversation titles ("6 Train Not Stopping"),
  // pinning the bar on permanently — so we only match generation verbs.
  const STOP_SELECTORS = [
    'button[data-testid="stop-button"]',            // ChatGPT
    'button[data-testid="stop-streaming"]',         // ChatGPT (older)
    'button[aria-label="Stop response"]',           // Claude
    'button[aria-label*="stop generating" i]',      // ChatGPT / generic
    'button[aria-label*="stop streaming" i]',       // generic
    'button[aria-label*="stop response" i]',        // Claude / Gemini variants
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
    ".epitaxy-spark-working",      // Claude — the animated thinking star
  ];

  // Where to put the bar. Every anchor is a stable, in-flow container that
  // WRAPS the site's thinking indicator, so appending the bar as that
  // container's last child ("inside") lands it below the indicator (and below
  // any text that streams into the same container). findAnchor() picks the
  // candidate latest in document order, so a descendant container wins over an
  // ancestor.
  const ANCHORS = [
    '[data-is-streaming="true"]',             // Claude — streaming bubble
    // Claude star-only stage: the spark (.epitaxy-spark-working) sits in a row
    // inside .epitaxy-transcript-width. :has scopes us to the wrapper that
    // actually holds the spark, so the bar lands below the star row.
    ".epitaxy-transcript-width:has(.epitaxy-spark-working)",
    "div[data-test-render-count]",            // Claude — fallback turn container
    '[data-message-author-role="assistant"]', // ChatGPT
    ".result-streaming",                      // ChatGPT (older)
    // Gemini — the per-turn <model-response> CONTAINS the thinking dots
    // (thinking-dots-animation is nested deep inside it), so the bar as its
    // last child lands BELOW the dots in both the dots-only and dots+text
    // stages. Do NOT anchor on the dots themselves: they live in an
    // absolutely-positioned <thinking-overlay> whose in-flow parent collapses
    // before any text streams, which dropped the bar at the page bottom.
    "model-response",                         // Gemini
  ];

  let ads = [];
  let mockAd = (typeof self !== "undefined" && self.BB_MOCK_AD) || null;
  let enabled = true;
  let testMode = false;
  let active = false;
  let demoUntil = 0;
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

  // The ad currently on screen. We surface ONE ad at a time — the top of the
  // returned inventory (the auction winner) — and never rotate within a page;
  // cycling through several ads in one session read as spammy.
  function currentAd() {
    if (testMode) return mockAd || (ads.length ? ads[0] : null);
    return ads.length ? ads[0] : null;
  }

  bar.addEventListener("click", async () => {
    const ad = currentAd();
    if (!ad) return;
    // Live ads carry a campaign id so the click is recorded server-side through
    // a single-use token; mock/bundled ads have none and just open the URL.
    await send({ type: "BB_CLICK", mock: !!ad.mock, campaignId: ad.id });
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
    // Collect one candidate per selector, then pick the candidate LATEST in
    // document order (a descendant beats its ancestor). Priority lists fail
    // here: e.g. Claude keeps an empty streaming bubble ABOVE the thinking
    // star, and anchoring there put the bar above the star.
    const candidates = [];
    for (const sel of ANCHORS) {
      try {
        const els = document.querySelectorAll(sel);
        if (els.length) candidates.push(els[els.length - 1]);
      } catch (_) {}
    }
    if (!candidates.length) return null;
    let best = candidates[0];
    for (let i = 1; i < candidates.length; i++) {
      const c = candidates[i];
      try {
        if (
          best !== c &&
          typeof best.compareDocumentPosition === "function" &&
          best.compareDocumentPosition(c) & Node.DOCUMENT_POSITION_FOLLOWING
        ) {
          best = c;
        }
      } catch (_) {}
    }
    return best;
  }
  // Returns true when the bar has somewhere legitimate to live.
  // Re-checked every tick: these apps keep inserting elements (the star, the
  // dots, streamed text) after we mount, so we re-assert the bar's position.
  function mount() {
    const el = findAnchor();
    if (el) {
      try {
        if (typeof el.appendChild === "function") {
          // keep the bar as the last child of the reply container, below the
          // thinking indicator and any streamed text
          if (!(bar.parentElement === el && el.lastElementChild === bar)) {
            el.appendChild(bar);
          }
          anchorEl = el;
          bar.classList.add("bb-inline");
          return true;
        }
      } catch (_) {}
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
    // Busy/streaming markers must also be VISIBLE. A persistent-but-hidden
    // match (e.g. an always-present aria-busy live region) otherwise pins the
    // bar "on" forever — which is what regressed on ChatGPT.
    for (const sel of BUSY_SELECTORS) {
      const els = document.querySelectorAll(sel);
      for (const el of els) if (isVisible(el)) return true;
    }
    return false;
  }

  // ---------- main loop ----------
  let spinTimer = null;
  function startActive() {
    if (active) return;
    active = true;
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
  function tick() {
    // keep the bar pinned to the streaming reply across re-renders; show only
    // once an anchor exists so it never starts at the bottom of the page
    if (mount()) bar.classList.add("bb-show");
    else bar.classList.remove("bb-show");
    render();
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
    // Honour both the user toggle and the server killswitch (state.serving).
    enabled = state ? state.enabled !== false && state.serving !== false : true;
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
