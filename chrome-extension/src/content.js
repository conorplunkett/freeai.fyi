// Betterbacks.ai — content script
// Detects when the AI assistant on this page is "thinking"/streaming, and shows
// ONE subtle, clickable sponsored line next to the spinner. You keep 90%.
(function () {
  if (window.__betterbacksLoaded) return;
  window.__betterbacksLoaded = true;

  const SPIN = ["✳", "✶", "✷", "✸", "✹", "✺", "✹", "✸", "✷", "✶"];
  const WORDS = ["Thinking", "Discombobulating", "Percolating", "Simmering", "Noodling", "Conjuring", "Computing"];

  let ads = [];
  let enabled = true;
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

  bar.addEventListener("click", async () => {
    const ad = ads[adIdx % (ads.length || 1)];
    if (!ad) return;
    await send({ type: "BB_CLICK" });
    window.open(ad.url, "_blank", "noopener");
  });

  function mount() {
    if (!bar.isConnected) document.body.appendChild(bar);
  }

  // ---------- render ----------
  function render() {
    const ad = ads[adIdx % (ads.length || 1)];
    elSpin.textContent = SPIN[frame % SPIN.length];
    elWord.textContent = WORDS[wordIdx % WORDS.length];
    if (ad) {
      elChip.textContent = ad.chip;
      elChip.style.background = ad.color;
      elChip.style.color = ad.ink;
      elLine.textContent = ad.line;
    }
    frame++;
  }

  // ---------- generation detector ----------
  // Heuristics that work across claude.ai / chatgpt.com / gemini / etc:
  // a visible "Stop" control, an aria-busy region, or a known streaming class.
  function isThinking() {
    if (Date.now() < demoUntil) return true;
    // 1) a stop/streaming button is the strongest universal signal
    const btns = document.querySelectorAll(
      'button[data-testid="stop-button"], button[aria-label*="Stop" i], button[aria-label*="stop generating" i], [data-testid="stop-streaming"]'
    );
    for (const b of btns) {
      const r = b.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) return true;
    }
    // 2) aria-busy live regions
    if (document.querySelector('[aria-busy="true"]')) return true;
    // 3) legacy/explicit streaming markers
    if (document.querySelector(".result-streaming, [data-is-streaming='true'], .streaming-animation")) return true;
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
    // rotate the ad + word roughly every 2.6s
    if (frameCount % 26 === 0) {
      adIdx++;
      wordIdx++;
    }
    // one impression every 5s of serving
    const now = Date.now();
    if (now - lastImpressionAt >= 5000) {
      lastImpressionAt = now;
      send({ type: "BB_IMPRESSION" });
    }
  }

  // poll the page state ~3x/sec (cheap; observers on these apps are noisy)
  setInterval(() => {
    if (!enabled) {
      stopActive();
      return;
    }
    if (isThinking()) startActive();
    else stopActive();
  }, 350);

  // ---------- demo trigger from popup ----------
  chrome.runtime.onMessage.addListener((msg, _s, resp) => {
    if (msg.type === "BB_DEMO") {
      demoUntil = Date.now() + (msg.ms || 30000);
      resp && resp({ ok: true });
    }
    if (msg.type === "BB_REFRESH") {
      bootstrap();
      resp && resp({ ok: true });
    }
  });

  // ---------- bootstrap ----------
  async function bootstrap() {
    const state = await send({ type: "BB_GET_STATE" });
    enabled = state ? state.enabled !== false : true;
    ads = (await send({ type: "BB_GET_ADS" })) || self.BB_ADS || [];
  }
  bootstrap();
})();
