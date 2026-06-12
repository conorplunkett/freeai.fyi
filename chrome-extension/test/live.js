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

    await check("Claude star-only stage ⇒ bar shows BELOW the thinking star", async () => {
      // simulate Claude before any streaming text: last turn container, then
      // the thinking star as a LATER sibling, plus the Stop button
      await page.evaluate(() => {
        document.querySelector('[data-message-author-role="assistant"]').remove();
        const msgs = document.getElementById("messages");
        const turn = document.createElement("div");
        turn.setAttribute("data-test-render-count", "1");
        turn.id = "claude-turn";
        msgs.appendChild(turn);
        const star = document.createElement("div");
        star.id = "claude-star";
        star.textContent = "✳ Thinking about…";
        msgs.appendChild(star);
      });
      await page.waitForFunction(() => {
        const b = document.querySelector(".bb-bar.bb-show");
        const star = document.getElementById("claude-star");
        // bar must exist AND come after the star in document order
        return b && star && !!(star.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
      }, { timeout: 5000 });
      // restore the ChatGPT-style reply for the rest of the checks
      await page.evaluate(() => {
        document.getElementById("claude-turn").remove();
        document.getElementById("claude-star").remove();
        window.setGenerating(true);
      });
      await page.waitForSelector('[data-message-author-role="assistant"] .bb-bar.bb-show', { timeout: 5000 });
    });

    await check("Gemini thinking-dots stage ⇒ detected and bar sits below the dots", async () => {
      // dots alone, no stop button, no reply yet
      await page.evaluate(() => {
        window.setGenerating(false);
        document.querySelector('[data-message-author-role="assistant"]').remove();
        // Gemini's real markup: a <thinking-dots-animation> custom element
        // wrapping a .thinking-dots-animation lottie div
        const dots = document.createElement("thinking-dots-animation");
        dots.id = "gem-dots";
        dots.innerHTML = '<div class="thinking-dots-animation"></div>';
        document.getElementById("messages").appendChild(dots);
      });
      await page.waitForFunction(() => {
        const b = document.querySelector(".bb-bar.bb-show");
        const dots = document.getElementById("gem-dots");
        return b && dots && !!(dots.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
      }, { timeout: 5000 });
      // clean up, restore the standard generating state
      await page.evaluate(() => {
        document.getElementById("gem-dots").remove();
        window.setGenerating(true);
      });
      await page.waitForSelector('[data-message-author-role="assistant"] .bb-bar.bb-show', { timeout: 5000 });
    });

    await check("bar is actually rendered (visible, has ad copy)", async () => {
      const info = await page.$eval(".bb-bar", (el) => {
        const r = el.getBoundingClientRect();
        return { w: r.width, h: r.height, line: el.querySelector(".bb-line").textContent, tag: el.querySelector(".bb-tag").textContent };
      });
      assert.ok(info.w > 0 && info.h > 0, "bar has no box");
      assert.ok(info.line.length > 0, "no ad line rendered");
      assert.match(info.tag, /50%/);
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

    await check("Test Mode without generation ⇒ bar stays hidden", async () => {
      await setState({ testMode: true });
      await refreshTab();
      await sleep(1200);
      const shown = await page.$(".bb-bar.bb-show");
      assert.strictEqual(shown, null, "test-mode ad must also wait for generation");
    });

    await check("Test Mode while generating ⇒ labelled mock ad renders", async () => {
      await page.evaluate(() => window.setGenerating(true));
      await page.waitForSelector(".bb-bar.bb-show.bb-test", { timeout: 5000 });
      const tag = await page.$eval(".bb-bar .bb-tag", (el) => el.textContent);
      assert.match(tag, /TEST AD/);
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
