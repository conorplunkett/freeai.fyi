// FreeAI.fyi — content script
// Detects when the AI assistant on this page is "thinking"/streaming, and shows
// ONE subtle, clickable sponsored line near the composer. You keep 90%.
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

  const SPIN = ["✳", "✶", "✷", "✸", "✹", "✺", "✹", "✸", "✷", "✶"];
  const WORDS = ["Thinking", "Discombobulating", "Percolating", "Simmering", "Noodling", "Conjuring", "Computing"];

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
  const BUSY_SELECTORS = ['[aria-busy="true"]', '.result-streaming', "[data-is-streaming='true']", ".streaming-animation"];

  let ads = [];
  let mockAd = (typeof self !== "undefined" && self.BB_MOCK_AD) || null;
  let enabled = true;
  let testMode = false;
  let active = false;
  let demoUntil = 0;
  let adIdx = 0;
  let wordIdx = 0;
  let frame = 0;
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
    '<span class="bb-spin">✳</span>' +
    '<span class="bb-word">Thinking</span><span class="bb-dots">…</span>' +
    '<span class="bb-sep">·</span>' +
    '<span class="bb-chip">R</span>' +
    '<span class="bb-line">Ramp · save time and money</span>' +
    '<span class="bb-tag">sponsored · you keep 90%</span>';
  const elSpin = bar.querySelector(".bb-spin");
  const elWord = bar.querySelector(".bb-word");
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

  function mount() {
    if (!bar.isConnected && document.body) document.body.appendChild(bar);
  }

  // ---------- render ----------
  function render() {
    const ad = currentAd();
    elSpin.textContent = SPIN[frame % SPIN.length];
    elWord.textContent = WORDS[wordIdx % WORDS.length];
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
      elTag.textContent = "sponsored · you keep 90%";
      bar.classList.remove("bb-test");
    }
    frame++;
  }

  // ---------- generation detector ----------
  function isVisible(el) {
    if (!el) return false;
    if (typeof el.getBoundingClientRect !== "function") return true; // test/mock DOM
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }
  function isThinking() {
    if (testMode) return true; // Test Mode keeps the bar up regardless
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
    mount();
    bar.classList.add("bb-show");
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
    render();
    frameCount++;
    // rotate the ad + word roughly every 2.6s (skip rotation while testing —
    // the mock ad should stay put so it's easy to inspect)
    if (!testMode && frameCount % 26 === 0) {
      adIdx++;
      wordIdx++;
    }
    // one impression every 5s of serving
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
