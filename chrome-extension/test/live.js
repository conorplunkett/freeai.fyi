// FreeAI.fyi — live browser test.
// Loads the REAL unpacked extension into actual Chrome (new headless) via
// Puppeteer, points it at a local fake chat page, and verifies end-to-end in a
// real browser what test/run.js verifies in a mock DOM:
//   the content script + CSS inject · Test Mode renders the labelled mock ad ·
//   the Stop-button detector shows/hides the bar · impressions reach the
//   service worker and the 50% earnings math lands in chrome.storage.
//
// The only fixture trickery: the manifest is copied to a temp dir with
// http://127.0.0.1/* added to its match patterns, since the shipped manifest
// (rightly) only matches the real chat sites. All source files are the real ones.
//
// Usage: node test/live.js   (or: npm run test:live)

const assert = require("node:assert");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const puppeteer = require("puppeteer");

const ROOT = path.join(__dirname, "..");

let pass = 0;
const check = async (name, fn) => {
  await fn();
  pass++;
  console.log("  ✓ " + name);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- fixture: the extension with localhost added to its matches ----------
function stageExtension() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "freeai-ext-"));
  fs.cpSync(ROOT, dir, {
    recursive: true,
    filter: (src) => !src.includes("node_modules") && !src.includes(path.sep + "test"),
  });
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
  manifest.host_permissions.push("http://127.0.0.1/*");
  manifest.content_scripts[0].matches.push("http://127.0.0.1/*");
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
  return dir;
}

// ---------- fixture: a minimal "chat" page ----------
const PAGE = `<!doctype html><html><body>
  <main><div id="messages"></div>
    <form id="composer"><textarea placeholder="Message the model"></textarea></form>
  </main>
  <script>
    // test page hook: toggle a ChatGPT-style stop button on demand
    window.setGenerating = (on, withReply = true) => {
      let b = document.querySelector('[data-testid="stop-button"]');
      let m = document.querySelector('[data-message-author-role="assistant"]');
      if (on) {
        if (!b) {
          b = document.createElement("button");
          b.setAttribute("data-testid", "stop-button");
          b.textContent = "Stop";
          document.getElementById("composer").appendChild(b);
        }
        if (withReply && !m) {
          // the streaming assistant reply — what the bar should anchor to
          m = document.createElement("div");
          m.setAttribute("data-message-author-role", "assistant");
          m.textContent = "Thinking…";
          document.getElementById("messages").appendChild(m);
        }
      } else {
        if (b) b.remove();
      }
    };
  </script>
</body></html>`;

async function main() {
  console.log("freeai chrome-extension LIVE browser test\n");

  const extDir = stageExtension();
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(PAGE);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}/`;

  const browser = await puppeteer.launch({
    headless: true, // new headless = full Chrome, supports MV3 extensions
    args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`, "--no-sandbox"],
  });

  try {
    // the MV3 service worker is the extension's brain — drive state through it
    const swTarget = await browser.waitForTarget((t) => t.type() === "service_worker", { timeout: 15000 });
    const sw = await swTarget.worker();
    const setState = (payload) => sw.evaluate((p) => chrome.storage.local.set(p), payload);
    const getState = () =>
      sw.evaluate(() => chrome.storage.local.get(["impressions", "clicks", "earnings", "testImpressions", "testClicks", "grossCpm", "revenueShare"]));

    const page = await browser.newPage();

    // the content script lives in Chrome's isolated world, so we observe it
    // purely through the DOM and drive its state through the service worker
    const refreshTab = () =>
      sw.evaluate(async () => {
        const tabs = await chrome.tabs.query({});
        for (const t of tabs) {
          try { await chrome.tabs.sendMessage(t.id, { type: "BB_REFRESH" }); } catch (_) {}
        }
      });

    await check("no generation signal ⇒ bar stays hidden", async () => {
      await setState({ enabled: true, testMode: false });
      await page.goto(url);
      await sleep(1200); // > one 350ms poll cycle after document_idle
      const shown = await page.$(".bb-show");
      assert.strictEqual(shown, null);
    });

    await check("thinking but no reply area yet ⇒ bar stays hidden (no bottom flash)", async () => {
      await page.evaluate(() => window.setGenerating(true, false)); // stop button only
      await sleep(1200);
      const shown = await page.$(".bb-bar.bb-show");
      assert.strictEqual(shown, null, "bar must not appear before the reply area exists");
    });

    await check("a VISIBLE sidebar item titled '...Not Stopping' does NOT trigger the bar", async () => {
      // the real ChatGPT regression: a sidebar conversation button whose
      // aria-label contains "stop" must not be read as a stop-generation control
      await page.evaluate(() => {
        window.setGenerating(false);
        const b = document.createElement("button");
        b.id = "sidebar-stop";
        b.setAttribute("aria-label", "Open conversation options for 6 Train Not Stopping");
        b.textContent = "6 Train Not Stopping";
        document.body.appendChild(b);
      });
      await sleep(1200);
      const shown = await page.$(".bb-bar.bb-show");
      assert.strictEqual(shown, null, "a non-generation 'stop' label showed the ad");
      await page.evaluate(() => document.getElementById("sidebar-stop").remove());
    });

    await check("a HIDDEN busy/streaming marker does NOT trigger the bar (the ChatGPT regression)", async () => {
      // a persistent but invisible aria-busy region must not pin the bar "on"
      await page.evaluate(() => {
        window.setGenerating(false);
        const ghost = document.createElement("div");
        ghost.id = "ghost-busy";
        ghost.setAttribute("aria-busy", "true");
        ghost.style.display = "none";
        document.body.appendChild(ghost);
      });
      await sleep(1200);
      const shown = await page.$(".bb-bar.bb-show");
      assert.strictEqual(shown, null, "hidden aria-busy must not show the ad");
      await page.evaluate(() => document.getElementById("ghost-busy").remove());
    });

    await check("Stop button appears ⇒ bar shows (real detection path)", async () => {
      await page.evaluate(() => window.setGenerating(true));
      await page.waitForSelector(".bb-bar.bb-show", { timeout: 10000 });
      const isTest = await page.$eval(".bb-bar", (el) => el.classList.contains("bb-test"));
      assert.strictEqual(isTest, false, "real flow must not be tagged as test");
    });

    await check("bar is anchored inline at the streaming reply, not fixed at the bottom", async () => {
      const placed = await page.$eval(".bb-bar", (el) => ({
        inline: el.classList.contains("bb-inline"),
        inReply: !!el.closest('[data-message-author-role="assistant"]'),
        position: getComputedStyle(el).position,
      }));
      assert.ok(placed.inline, "bar missing bb-inline");
      assert.ok(placed.inReply, "bar not inside the assistant's reply");
      assert.notStrictEqual(placed.position, "fixed", "bar still fixed-positioned");
    });

    await check("bar is left-aligned in the reply", async () => {
      const d = await page.$eval(".bb-bar", (el) => {
        const p = el.closest('[data-message-author-role="assistant"]').getBoundingClientRect();
        return el.getBoundingClientRect().left - p.left;
      });
      assert.ok(d < 24, `bar starts ${d}px from the reply's left edge — not left-aligned`);
    });

    await check("ChatGPT: bar never anchors inside .result-streaming (no mid-stream snap)", async () => {
      // ChatGPT's streaming markdown (.result-streaming) is a DESCENDANT of the
      // message container. If the bar anchors inside it, finalized content that
      // ChatGPT appends AFTER the stream node strands the bar above it for a
      // beat. The bar must stay the message container's last child throughout.
      await page.evaluate(() => {
        const turn = document.querySelector('[data-message-author-role="assistant"]');
        const stream = document.createElement("div");
        stream.className = "result-streaming";
        stream.id = "cgpt-stream";
        stream.textContent = "streaming answer…";
        turn.appendChild(stream);
      });
      // bar sits below the streaming block, not inside it
      await page.waitForFunction(() => {
        const turn = document.querySelector('[data-message-author-role="assistant"]');
        const b = turn && turn.querySelector(".bb-bar.bb-show");
        const stream = document.getElementById("cgpt-stream");
        return b && turn.lastElementChild === b && !stream.contains(b);
      }, { timeout: 5000 });
      // ChatGPT appends the finalized block AFTER .result-streaming → the bar
      // must re-seat below it, never get stranded above
      await page.evaluate(() => {
        const turn = document.querySelector('[data-message-author-role="assistant"]');
        const after = document.createElement("div");
        after.id = "cgpt-after";
        after.textContent = "finalized block";
        const stream = document.getElementById("cgpt-stream");
        turn.insertBefore(after, stream.nextSibling);
      });
      await page.waitForFunction(() => {
        const turn = document.querySelector('[data-message-author-role="assistant"]');
        const b = turn.querySelector(".bb-bar");
        const after = document.getElementById("cgpt-after");
        return (
          b &&
          turn.lastElementChild === b &&
          !!(after.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING)
        );
      }, { timeout: 3000 });
      // cleanup the streaming fixtures so later checks see a clean turn
      await page.evaluate(() => {
        for (const id of ["cgpt-stream", "cgpt-after"]) {
          const n = document.getElementById(id);
          if (n) n.remove();
        }
      });
    });

    await check("Claude star-only stage ⇒ bar shows below the star, in the turn container", async () => {
      // Claude anchors on the per-turn div[data-test-render-count] container.
      // The visible thinking star (.epitaxy-spark-working) drives detection;
      // the bar should land as the turn's last child, below the star, and STAY.
      await page.evaluate(() => {
        document.querySelector('[data-message-author-role="assistant"]').remove();
        const turn = document.createElement("div");
        turn.setAttribute("data-test-render-count", "1");
        turn.id = "claude-turn";
        const star = document.createElement("div");
        star.className = "epitaxy-spark-working";
        star.id = "claude-star";
        star.style.cssText = "display:block;width:18px;height:18px"; // real star is visible
        turn.appendChild(star);
        document.getElementById("messages").appendChild(turn);
      });
      await page.waitForFunction(() => {
        const turn = document.getElementById("claude-turn");
        const b = turn && turn.querySelector(".bb-bar.bb-show");
        const star = document.getElementById("claude-star");
        return (
          b && star &&
          turn.lastElementChild === b &&
          !!(star.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING)
        );
      }, { timeout: 5000 });
      // a node streaming in after the bar must still leave the bar last
      await page.evaluate(() => {
        const late = document.createElement("div");
        late.textContent = "first words…";
        const turn = document.getElementById("claude-turn");
        turn.insertBefore(late, turn.querySelector(".bb-bar"));
      });
      await page.waitForFunction(
        () => document.getElementById("claude-turn").lastElementChild.classList.contains("bb-bar"),
        { timeout: 3000 }
      );
      // restore the ChatGPT-style reply for the rest of the checks
      await page.evaluate(() => {
        document.getElementById("claude-turn").remove();
        window.setGenerating(true);
      });
      await page.waitForSelector('[data-message-author-role="assistant"] .bb-bar.bb-show', { timeout: 5000 });
    });

    // Build Gemini's REAL spinner-stage structure (captured live in Chrome).
    // Each Q&A turn is a `.conversation-container` wrapping a <user-query> and a
    // <model-response>. While the model is only showing its loading spinner the
    // ACTIVE turn is a <pending-request class="conversation-container"> that
    // holds the new <user-query> but NO <model-response> yet — so the only
    // <model-response> in the DOM is the PREVIOUS (stale) turn. A document-order
    // pick lands the bar in that stale turn, ABOVE the newest user message. The
    // real loader (<chat-loading-animation>) is a detached, absolutely-
    // positioned page-level overlay — NOT inside the turn — so we can't climb
    // from it; we climb from the newest <user-query> to its turn instead.
    const buildGeminiSpinnerStage = () => {
      const existing = document.querySelector('[data-message-author-role="assistant"]');
      if (existing) existing.remove();
      window.setGenerating(false);
      const msgs = document.getElementById("messages");
      msgs.innerHTML = "";
      // a COMPLETED earlier turn — holds the only <model-response> in the DOM.
      const prev = document.createElement("div");
      prev.className = "conversation-container";
      prev.id = "gem-prev-turn";
      const prevUser = document.createElement("user-query");
      prevUser.textContent = "first question";
      const staleMr = document.createElement("model-response");
      staleMr.id = "gem-stale-mr";
      staleMr.textContent = "first answer (completed earlier)";
      prev.appendChild(prevUser);
      prev.appendChild(staleMr);
      // the ACTIVE turn during the spinner stage: a <pending-request> carrying
      // the .conversation-container class, holding the new <user-query> but no
      // <model-response> yet.
      const active = document.createElement("pending-request");
      active.className = "conversation-container";
      active.id = "gem-active-turn";
      const newestUser = document.createElement("user-query");
      newestUser.id = "gem-newest-user";
      newestUser.textContent = "newest question";
      active.appendChild(newestUser);
      // the detached page-level loader overlay (not inside any turn)
      const overlay = document.createElement("chat-loading-animation");
      overlay.style.cssText = "position:absolute;top:100px;left:0";
      // a visible Stop button is what flags generation (drives isThinking)
      const stop = document.createElement("button");
      stop.id = "gem-stop";
      stop.setAttribute("aria-label", "Stop response");
      stop.textContent = "Stop";
      msgs.appendChild(prev);
      msgs.appendChild(active);
      msgs.appendChild(overlay);
      document.getElementById("composer").appendChild(stop);
    };

    await check("Gemini spinner stage (no <model-response> yet) ⇒ bar anchors to the active turn, below the newest user message — not the stale turn", async () => {
      await page.evaluate(buildGeminiSpinnerStage);
      await page.waitForFunction(() => {
        const active = document.getElementById("gem-active-turn");
        const stale = document.getElementById("gem-stale-mr");
        const newestUser = document.getElementById("gem-newest-user");
        const b = document.querySelector(".bb-bar.bb-show");
        return (
          b && active && stale && newestUser &&
          active.contains(b) &&              // the ACTIVE (newest user's) turn
          !stale.contains(b) &&             // NOT the stale prior model-response
          active.lastElementChild === b &&  // sits at the end of the turn
          !!(newestUser.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) // below the user msg
        );
      }, { timeout: 5000 });
    });

    await check("Gemini stream stage (turn swaps to a real .conversation-container) ⇒ bar stays in the active turn, below the reply", async () => {
      // Gemini replaces the <pending-request> with a real .conversation-container
      // and streams the answer into a <model-response> inside it.
      await page.evaluate(() => {
        const old = document.getElementById("gem-active-turn");
        const real = document.createElement("div");
        real.className = "conversation-container";
        real.id = "gem-active-turn-real";
        const u = document.createElement("user-query");
        u.id = "gem-newest-user";
        u.textContent = "newest question";
        const mr = document.createElement("model-response");
        mr.id = "gem-active-mr";
        mr.textContent = "streaming the answer…";
        real.appendChild(u);
        real.appendChild(mr);
        old.replaceWith(real);
      });
      await page.waitForFunction(() => {
        const turn = document.getElementById("gem-active-turn-real");
        const mr = document.getElementById("gem-active-mr");
        const b = turn && turn.querySelector(".bb-bar.bb-show");
        return (
          b && mr &&
          turn.lastElementChild === b &&     // still the turn's last child
          !!(mr.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) // below the reply
        );
      }, { timeout: 5000 });
      // restore the ChatGPT-style reply for the rest of the checks
      await page.evaluate(() => {
        document.getElementById("messages").innerHTML = "";
        const stop = document.getElementById("gem-stop");
        if (stop) stop.remove();
        window.setGenerating(true);
      });
      await page.waitForSelector('[data-message-author-role="assistant"] .bb-bar.bb-show', { timeout: 5000 });
    });

    await check("elements inserted after the bar push it back below within a tick", async () => {
      // the apps keep appending (star, dots, streamed text) after we mount —
      // the bar must re-seat itself at the bottom
      await page.evaluate(() => {
        const turn = document.querySelector('[data-message-author-role="assistant"]');
        const late = document.createElement("div");
        late.id = "late-insert";
        late.textContent = "streamed-in later";
        turn.appendChild(late); // now sits BELOW the bar
      });
      await page.waitForFunction(() => {
        const turn = document.querySelector('[data-message-author-role="assistant"]');
        return turn && turn.lastElementChild && turn.lastElementChild.classList.contains("bb-bar");
      }, { timeout: 3000 });
    });

    await check("bar is actually rendered (visible, has ad copy)", async () => {
      const info = await page.$eval(".bb-bar", (el) => {
        const r = el.getBoundingClientRect();
        return { w: r.width, h: r.height, line: el.querySelector(".bb-line").textContent };
      });
      assert.ok(info.w > 0 && info.h > 0, "bar has no box");
      assert.ok(info.line.length > 0, "no ad line rendered");
    });

    await check("real impression lands in storage at 50% of gross", async () => {
      await sw.evaluate(() => chrome.storage.local.set({ impressions: 0, earnings: 0 }));
      await sleep(5500); // impressions tick every 5s served
      const s = await getState();
      assert.ok(s.impressions >= 1, "no real impression recorded");
      const per = (s.grossCpm / 1000) * s.revenueShare;
      assert.ok(Math.abs(s.earnings - s.impressions * per) < 1e-9, "earnings ≠ impressions × 50% net");
    });

    await check("Stop button gone ⇒ bar hides", async () => {
      await page.evaluate(() => window.setGenerating(false));
      await page.waitForFunction(() => !document.querySelector(".bb-bar.bb-show"), { timeout: 5000 });
    });

    await check("on hide the box stays mounted + space-reserved and fades over 2s (no reflow)", async () => {
      const meta = await page.$eval(".bb-bar", (el) => {
        const s = getComputedStyle(el);
        return { connected: el.isConnected, display: s.display, opacityDur: s.transitionDuration };
      });
      assert.ok(meta.connected, "bar was removed from the DOM on hide");
      assert.strictEqual(meta.display, "flex", "box collapsed instead of reserving space");
      assert.ok(/(^|,)\s*2s/.test(meta.opacityDur), `expected a 2s fade, got ${meta.opacityDur}`);
      // partway through the 2s fade it should be visibly dimming, not snapped off
      await sleep(700);
      const mid = await page.$eval(".bb-bar", (el) => parseFloat(getComputedStyle(el).opacity));
      assert.ok(mid > 0 && mid < 1, `expected a partial fade, got opacity ${mid}`);
      // and after the full 2s it should be invisible (still mounted)
      await sleep(1800);
      const end = await page.$eval(".bb-bar", (el) => {
        const s = getComputedStyle(el);
        return { opacity: parseFloat(s.opacity), visibility: s.visibility };
      });
      assert.ok(end.opacity < 0.05, `did not finish fading, opacity ${end.opacity}`);
      assert.strictEqual(end.visibility, "hidden", "faded box should be visibility:hidden");
    });

    await check("a new generation fades the same box back in (reused, not recreated)", async () => {
      await page.evaluate(() => window.setGenerating(true));
      await page.waitForSelector(".bb-bar.bb-show", { timeout: 5000 });
      const n = await page.$$eval(".bb-bar", (els) => els.length);
      assert.strictEqual(n, 1, "more than one bar exists — box should be reused");
      await page.evaluate(() => window.setGenerating(false));
      await page.waitForFunction(() => !document.querySelector(".bb-bar.bb-show"), { timeout: 5000 });
    });

    await check("Test Mode without generation ⇒ bar stays hidden", async () => {
      await setState({ testMode: true });
      await refreshTab();
      await sleep(1200);
      const shown = await page.$(".bb-bar.bb-show");
      assert.strictEqual(shown, null, "test-mode ad must also wait for generation");
    });

    await check("Test Mode while generating ⇒ labelled mock ad renders", async () => {
      await page.evaluate(() => window.setGenerating(true));
      // bb-test class is the test-mode marker now that the sub-tag pill is gone.
      await page.waitForSelector(".bb-bar.bb-show.bb-test", { timeout: 5000 });
    });

    await check("test-mode impressions tick the mock counter, not real earnings", async () => {
      const before = await getState();
      await sleep(5500);
      const after = await getState();
      assert.ok(after.testImpressions > before.testImpressions, "no mock impression recorded");
      assert.strictEqual(after.impressions, before.impressions, "test mode polluted real impressions");
      assert.strictEqual(after.earnings, before.earnings, "test mode polluted real earnings");
    });

    await check("clicking the test ad records a mock click only", async () => {
      const before = await getState();
      await page.click(".bb-bar .bb-line");
      await sleep(400);
      const after = await getState();
      assert.strictEqual(after.testClicks, before.testClicks + 1);
      assert.strictEqual(after.clicks, before.clicks);
      assert.strictEqual(after.earnings, before.earnings);
    });

    console.log(`\nall ${pass} live checks passed — the extension works in a real Chrome. 🤑`);
  } finally {
    await browser.close();
    server.close();
    fs.rmSync(extDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error("\n✗ FAILED after " + pass + " checks:\n", err);
  process.exit(1);
});
