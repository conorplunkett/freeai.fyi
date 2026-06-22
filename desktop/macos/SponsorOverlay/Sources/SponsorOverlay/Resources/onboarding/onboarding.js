/* FreeAI.fyi — macOS desktop onboarding.
 *
 * A faithful vanilla-JS port of the Claude Design handoff (onboarding/Onboarding.jsx).
 * Same 5 steps, same DOM/classes, same animations (spinner, ad cross-fade, earnings
 * ring) — but driven by real app state instead of the prototype's fake timers:
 *
 *   • Step 3 "Open System Settings" asks the app to open the Accessibility pane;
 *     the app polls the real permission and pushes it back via freeaiBridge.setPermission,
 *     which gates "Continue" exactly like the mock's perm === "ok".
 *   • "Launch at login" registers/unregisters the app (SMAppService) through the bridge.
 *   • Step 4 sign-in opens FreeAI's real web sign-in in the browser.
 *   • "Open FreeAI" closes the window.
 *
 * Swift ↔ JS bridge:
 *   JS → app: window.webkit.messageHandlers.freeai.postMessage({ action, ... })
 *   app → JS: window.freeaiBridge.setPermission(state) / setLaunchState(on)
 * When no native bridge is present (previewing in a plain browser) it falls back
 * to the prototype's simulated behaviour so the design still demos standalone.
 */
(function () {
  "use strict";

  var STEPS = [
    { t: "Welcome",      s: "what FreeAI is" },
    { t: "How it works", s: "the 10-second tour" },
    { t: "Grant access", s: "access + login" },
    { t: "Save credits", s: "connect account" },
    { t: "All set",      s: "start earning" },
  ];

  // Rotating sponsor lines for the live demo pill.
  var ADS = [
    { chip: "L", color: "#5b5bd6", ink: "#fff",     brand: "Linear", line: "issue tracking built for speed" },
    { chip: "R", color: "#ffd54a", ink: "#1b1e25",  brand: "Ramp",   line: "save time and money" },
    { chip: "△", color: "#000", ink: "#fff",   brand: "Vercel", line: "ship your agent to prod" },
  ];

  var NEXT_LABEL = ["Get started", "Continue", "Continue", "Continue", "Open FreeAI"];
  var LAST = STEPS.length - 1;

  // ── State ──
  var step = 0;
  var maxStep = 0;         // furthest step reached — completed steps keep their ✓
  var perm = "off";        // off | wait | ok
  var launch = false;      // reflects the app's real launch-at-login status
  var email = "";
  var sent = false;
  var sentVia = "email";   // email | google

  // ── Native bridge ──
  var hasNative = !!(window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.freeai);
  function native(action, payload) {
    if (!hasNative) return false;
    try {
      var msg = { action: action };
      if (payload) for (var k in payload) msg[k] = payload[k];
      window.webkit.messageHandlers.freeai.postMessage(msg);
      return true;
    } catch (e) { return false; }
  }

  var root = document.getElementById("root");
  var demoTimers = [];
  function clearDemo() { demoTimers.forEach(clearTimeout); demoTimers = []; }

  // ── Small DOM helpers ──
  function el(html) {
    var t = document.createElement("template");
    t.innerHTML = html.trim();
    return t.content.firstElementChild;
  }
  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }

  // ── Inline SVGs (verbatim from the handoff) ──
  var PERM_SVG =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
    '<circle cx="12" cy="5" r="2" /><path d="M12 7v6" /><path d="M5 9c4 1.5 10 1.5 14 0" /><path d="M9 21l3-7 3 7" /></svg>';
  var PRIVACY_SVG =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M12 2l8 4v6c0 5-3.5 8-8 10-4.5-2-8-5-8-10V6z" /><path d="M9 12l2 2 4-4" /></svg>';
  // Power glyph for the "Launch at login" card.
  var LAUNCH_SVG =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M12 2v9" /><path d="M6.4 6.4a9 9 0 1 0 11.2 0" /></svg>';
  // The actual menu-bar mark, as a wireframe: a hollow rounded chip with the
  // mono "F$" inside — mirrors makeStatusIcon() in main.swift. Inherits the
  // surrounding text colour via currentColor.
  var MENUBAR_WIRE_SVG =
    '<svg class="mb-wire" viewBox="0 0 28 18" fill="none" xmlns="http://www.w3.org/2000/svg">' +
    '<rect x="1.1" y="1.1" width="25.8" height="15.8" rx="4.6" stroke="currentColor" stroke-width="1.3" />' +
    '<text x="14" y="12.7" text-anchor="middle" font-family="\'JetBrains Mono\', ui-monospace, monospace" ' +
    'font-size="9" font-weight="700" fill="currentColor">F$</text></svg>';
  var GOOGLE_SVG =
    '<svg viewBox="0 0 24 24"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.27-4.74 3.27-8.1z"/>' +
    '<path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23z"/>' +
    '<path fill="#FBBC05" d="M5.84 14.1a6.6 6.6 0 0 1 0-4.2V7.06H2.18a11 11 0 0 0 0 9.88l3.66-2.84z"/>' +
    '<path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84C6.71 7.31 9.14 5.38 12 5.38z"/></svg>';

  // ── Step panes (return HTML strings; wiring happens after mount) ──

  function paneWelcome() {
    return '' +
      '<div class="fade welcome">' +
        '<div class="markwrap">' +
          '<div class="bigmark">F$</div>' +
          '<div class="mark-meta">' +
            '<div class="nm">FreeAI<span style="color:var(--gray-2);font-weight:600">.fyi</span></div>' +
            '<div class="vr">v1.0 · macOS</div>' +
          '</div>' +
        '</div>' +
        '<span class="eyebrow">Get Claude for free</span>' +
        '<h1 class="h-title">Earn Claude credits while you work.</h1>' +
        '<p class="h-sub">FreeAI shows <b>one</b> subtle sponsored line while your AI assistant is thinking — and gives you back <b>50%</b> of what it earns, as Claude credits.</p>' +
        '<ul class="bullets">' +
          '<li><span class="tick">✓</span><div>Lives quietly in your menu bar. <b>No new app to open.</b></div></li>' +
          '<li><span class="tick">✓</span><div>Works with <b>ChatGPT, Claude &amp; Claude Code</b> out of the box.</div></li>' +
          '<li><span class="tick">✓</span><div>Reads <b>none</b> of your prompts. Setup takes under a minute.</div></li>' +
        '</ul>' +
      '</div>';
  }

  function paneHow() {
    return '' +
      '<div class="fade">' +
        '<span class="eyebrow">How it works</span>' +
        '<h1 class="h-title">We turned the spinner into income.</h1>' +
        '<div class="how">' +
          '<div class="demo">' +
            '<div class="demo-lbl">On claude.ai · live</div>' +
            '<div class="chat">' +
              '<div class="msg me">Refactor this auth flow for me</div>' +
              '<div class="msg">On it — reading through your handlers…</div>' +
            '</div>' +
          '</div>' +
          '<div class="how-col">' +
            '<ul class="how-list">' +
              '<li><span class="how-num">1</span><div><div class="ht">Keep FreeAI running</div>' +
                '<div class="hs">Lives in your menu bar as the <b>F$</b> icon, watching for the "thinking" moment.</div></div></li>' +
              '<li><span class="how-num">2</span><div><div class="ht">Your assistant thinks</div>' +
                '<div class="hs">One calm line, labeled <span style="font-family:var(--mono);font-size:11px;color:var(--accent-d)">ad·</span>, slips in beside the spinner.</div></div></li>' +
              '<li><span class="how-num">3</span><div><div class="ht">You earn, split 50/50</div>' +
                '<div class="hs">Half the revenue becomes Claude credits — redeem for gift cards.</div></div></li>' +
            '</ul>' +
          '</div>' +
        '</div>' +
      '</div>';
  }

  function permBadge() {
    if (perm === "ok")   return '<span class="status ok"><span class="d"></span>Granted</span>';
    if (perm === "wait") return '<span class="status wait"><span class="d"></span>Waiting for System Settings…</span>';
    return '<span class="status off"><span class="d"></span>Not granted</span>';
  }
  function launchBadge() {
    return launch
      ? '<span class="status ok"><span class="d"></span>Enabled</span>'
      : '<span class="status off"><span class="d"></span>Not enabled</span>';
  }

  function panePermission() {
    return '' +
      '<div class="fade">' +
        '<span class="eyebrow">Two quick toggles</span>' +
        '<h1 class="h-title">Let FreeAI see the spinner.</h1>' +
        '<p class="h-sub">macOS <b>Accessibility</b> access lets FreeAI tell when your assistant starts thinking, so it can place the line correctly.<br><b>It never reads your screen or prompts.</b></p>' +
        '<div class="perm-card">' +
          '<div class="perm-icon">' + PERM_SVG + '</div>' +
          '<div class="perm-main">' +
            '<div class="pt">Accessibility access</div>' +
            '<div class="ps">Required to position the line. Toggle FreeAI on under Privacy &amp; Security ▸ Accessibility.</div>' +
            '<div class="perm-row">' +
              permBadge() +
              (perm !== "ok" ? '<button class="btn-sys" data-act="open-settings">Open System Settings</button>' : '') +
            '</div>' +
          '</div>' +
        '</div>' +
        '<div class="perm-card">' +
          '<div class="perm-icon">' + LAUNCH_SVG + '</div>' +
          '<div class="perm-main">' +
            '<div class="pt">Launch at login</div>' +
            '<div class="ps">Start earning automatically every time you sign in — required so FreeAI keeps running.</div>' +
            '<div class="perm-row">' +
              launchBadge() +
              '<label class="switch"><input type="checkbox" data-act="launch"' + (launch ? " checked" : "") + '><span class="slider"></span></label>' +
            '</div>' +
          '</div>' +
        '</div>' +
        '<div class="privacy">' + PRIVACY_SVG + ' Open-source &amp; auditable — clicks are counted server-side, never your keystrokes.</div>' +
      '</div>';
  }

  function paneSignin() {
    var head = '' +
      '<span class="eyebrow">Save your credits</span>' +
      '<h1 class="h-title">Where should we send the money?</h1>' +
      '<p class="h-sub">Connect an account so your Claude credits accrue to you. We only use it to track your balance and send gift cards.</p>';
    if (sent) {
      var msg = sentVia === "google"
        ? 'Continue with Google in your browser to finish — you can keep setting up here.'
        : 'Magic link on its way to <b>' + esc(email) + '</b>. Finish in the browser tab we opened — you can keep setting up here.';
      return '<div class="fade signin">' + head +
        '<div class="sent"><span class="chk">✓</span><div>' + msg + '</div></div></div>';
    }
    var valid = /\S+@\S+\.\S+/.test(email);
    return '' +
      '<div class="fade signin">' + head +
        '<div class="field">' +
          '<label class="flabel">Email — magic link</label>' +
          '<div class="input-row">' +
            '<input class="inp" type="email" placeholder="you@work.com" value="' + esc(email) + '">' +
            '<button class="btn-send" data-act="send"' + (valid ? "" : ' disabled style="opacity:.5;cursor:not-allowed"') + '>Send link</button>' +
          '</div>' +
        '</div>' +
        '<div class="or">or</div>' +
        '<button class="btn-google" data-act="google">' + GOOGLE_SVG + ' Continue with Google</button>' +
      '</div>';
  }

  function paneDone() {
    return '' +
      '<div class="fade done-pane">' +
        '<div class="done-top">' +
          ringHTML() +
          '<div class="done-copy">' +
            '<span class="eyebrow">You\'re all set</span>' +
            '<h1 class="h-title">FreeAI is earning.</h1>' +
            '<ul class="done-list">' +
              '<li><span class="tick">✓</span>Running in your menu bar</li>' +
              '<li><span class="tick">✓</span>Accessibility granted · launches at login</li>' +
              '<li><span class="tick">✓</span>Credits will accrue to your account</li>' +
            '</ul>' +
          '</div>' +
        '</div>' +
        '<div class="callout">Find FreeAI as the ' + MENUBAR_WIRE_SVG + ' icon up in your menu bar anytime.</div>' +
      '</div>';
  }

  // Earnings ring — size 150, stroke 13, target fill 0.001 (basically empty), matching the mock.
  var RING_SIZE = 150, RING_STROKE = 13;
  var RING_R = (RING_SIZE - RING_STROKE) / 2;
  var RING_C = 2 * Math.PI * RING_R;
  function ringHTML() {
    return '' +
      '<div class="ring" style="width:' + RING_SIZE + 'px;height:' + RING_SIZE + 'px">' +
        '<svg width="' + RING_SIZE + '" height="' + RING_SIZE + '" viewBox="0 0 ' + RING_SIZE + ' ' + RING_SIZE + '">' +
          '<defs><linearGradient id="og" x1="0" y1="0" x2="1" y2="1">' +
            '<stop offset="0" stop-color="var(--accent-grad-a)" /><stop offset="1" stop-color="var(--accent-grad-b)" />' +
          '</linearGradient></defs>' +
          '<circle cx="' + RING_SIZE / 2 + '" cy="' + RING_SIZE / 2 + '" r="' + RING_R + '" fill="none" stroke="var(--line)" stroke-width="' + RING_STROKE + '" />' +
          '<circle class="ring-arc" cx="' + RING_SIZE / 2 + '" cy="' + RING_SIZE / 2 + '" r="' + RING_R + '" fill="none" stroke="url(#og)" ' +
            'stroke-width="' + RING_STROKE + '" stroke-linecap="round" stroke-dasharray="' + RING_C + '" stroke-dashoffset="' + RING_C + '" ' +
            'transform="rotate(-90 ' + RING_SIZE / 2 + ' ' + RING_SIZE / 2 + ')" />' +
        '</svg>' +
        '<div class="ring-center"><div class="amt">$0.00</div><div class="goal">of $200</div></div>' +
      '</div>';
  }

  function paneFor(i) {
    switch (i) {
      case 0: return paneWelcome();
      case 1: return paneHow();
      case 2: return panePermission();
      case 3: return paneSignin();
      default: return paneDone();
    }
  }

  // ── Rail + nav ──
  // Completed steps (anything up to the furthest reached) keep their ✓ even when
  // you navigate back, and every visited step is clickable to jump to it.
  function railHTML() {
    var items = STEPS.map(function (st, i) {
      var active = i === step;
      var done = !active && i <= maxStep;     // ✓ persists for visited steps
      var visited = i <= maxStep;
      var cls = (active ? "active" : done ? "done" : "") + (visited ? " clickable" : "");
      var dot = done ? "✓" : (i + 1);
      var attr = visited ? ' data-step="' + i + '"' : "";
      return '<li class="' + cls.trim() + '"' + attr + '><span class="step-dot">' + dot + '</span>' +
        '<span class="step-txt"><span class="t">' + esc(st.t) + '</span><span class="s">' + esc(st.s) + '</span></span></li>';
    }).join("");
    return '' +
      '<div class="rail">' +
        '<div class="rail-brand"><span class="logo">F$</span><span class="wm">FreeAI<span class="dim">.fyi</span></span></div>' +
        '<ul class="steps">' + items + '</ul>' +
        '<div class="rail-foot"><div class="split"><b>50%</b> of every ad comes back to you.</div></div>' +
      '</div>';
  }

  function navHTML() {
    // Step 3 (Grant access) needs both Accessibility *and* launch-at-login.
    var canNext = step !== 2 || (perm === "ok" && launch);
    var dots = STEPS.map(function (_, i) {
      var cls = i === step ? "on" : i < step ? "past" : "";
      return '<i class="' + cls + '"></i>';
    }).join("");
    var btns = "";
    if (step > 0 && step < LAST) btns += '<button class="btn-back" data-act="back">Back</button>';
    if (step === 3 && !sent)     btns += '<button class="btn-skip" data-act="skip">Skip for now</button>';
    btns += '<button class="btn-next" data-act="next"' + (canNext ? "" : " disabled") + '>' +
      esc(NEXT_LABEL[step]) + '<span class="arr">→</span></button>';
    return '<div class="nav"><div class="dots">' + dots + '</div><div class="nav-btns">' + btns + '</div></div>';
  }

  // ── Render ──
  function render() {
    clearDemo();
    root.innerHTML =
      '<div class="win"><div class="body">' + railHTML() +
        '<div class="content"><div class="pane">' + paneFor(step) + '</div>' + navHTML() + '</div>' +
      '</div></div>';
    wire();
    if (step === 1) startDemo();
    if (step === LAST) startRing();
  }

  // ── Behaviour ──
  function next() { if (step < LAST) { step += 1; if (step > maxStep) maxStep = step; render(); } }
  function back() { if (step > 0)    { step -= 1; render(); } }
  // Jump straight to an already-visited step from the rail.
  function goTo(i) { if (i >= 0 && i <= maxStep && i !== step) { step = i; render(); } }

  function setLaunch(on) {
    launch = on;                               // optimistic; the app re-syncs the
    native("setLaunchAtLogin", { on: on });    // real registration state via setLaunchState
    if (step === 2) render();                  // refresh the badge + the Continue gate
  }

  function requestPermission() {
    if (perm !== "off") return;
    perm = "wait";
    render();
    if (!native("openSettings")) {
      // Browser preview: simulate the grant like the prototype did.
      setTimeout(function () { perm = "ok"; if (step === 2) render(); }, 1500);
    }
  }

  function sendEmail() {
    if (!/\S+@\S+\.\S+/.test(email)) return;
    sentVia = "email";
    sent = true;
    native("signinEmail", { email: email });
    render();
  }
  function signinGoogle() {
    sentVia = "google";
    sent = true;
    native("signinGoogle");
    render();
  }

  function finish() { if (!native("finish")) { step = 0; render(); } }

  // ── Wire the freshly rendered DOM ──
  function wire() {
    root.querySelectorAll("[data-act]").forEach(function (node) {
      var act = node.getAttribute("data-act");
      if (act === "launch") {
        node.addEventListener("change", function (e) { setLaunch(e.target.checked); });
        return;
      }
      if (act === "next") {
        node.addEventListener("click", function () { step === LAST ? finish() : next(); });
        return;
      }
      var handlers = {
        back: back,
        skip: next,
        "open-settings": requestPermission,
        send: sendEmail,
        google: signinGoogle,
      };
      if (handlers[act]) node.addEventListener("click", handlers[act]);
    });

    // Rail navigation — click any visited step to jump back to it.
    root.querySelectorAll(".steps li[data-step]").forEach(function (li) {
      li.addEventListener("click", function () {
        goTo(parseInt(li.getAttribute("data-step"), 10));
      });
    });

    var input = root.querySelector(".signin .inp");
    if (input) {
      input.addEventListener("input", function (e) {
        email = e.target.value;
        var btn = root.querySelector(".btn-send");
        var valid = /\S+@\S+\.\S+/.test(email);
        if (btn) {
          btn.disabled = !valid;
          btn.style.opacity = valid ? "" : ".5";
          btn.style.cursor = valid ? "" : "not-allowed";
        }
      });
      input.addEventListener("keydown", function (e) { if (e.key === "Enter") sendEmail(); });
    }
  }

  // ── Live demo pill: assistant "thinks", pill cross-fades spinner → ad ──
  function startDemo() {
    var chat = root.querySelector(".demo .chat");
    if (!chat) return;
    var adi = 0;
    function thinkPill() {
      return el('<div class="pill swap"><span class="spin">✳</span><span class="ptxt">Discombobulating…</span></div>');
    }
    function adPill(ad) {
      return el(
        '<div class="pill ad swap">' +
          '<span class="pchip" style="background:' + ad.color + ';color:' + ad.ink + '">' + esc(ad.chip) + '</span>' +
          '<span class="ptxt"><b style="color:#fff">' + esc(ad.brand) + '</b> — ' + esc(ad.line) + '</span>' +
          '<span class="ptag">ad·</span>' +
        '</div>');
    }
    function swap(node) {
      var old = chat.querySelector(".pill");
      if (old) old.remove();
      chat.appendChild(node);
    }
    function loop() {
      swap(thinkPill());
      demoTimers.push(setTimeout(function () { swap(adPill(ADS[adi])); }, 1500));
      demoTimers.push(setTimeout(function () { adi = (adi + 1) % ADS.length; loop(); }, 4200));
    }
    loop();
  }

  // ── Earnings ring fill ──
  function startRing() {
    var arc = root.querySelector(".ring-arc");
    if (!arc) return;
    setTimeout(function () { arc.style.strokeDashoffset = String(RING_C * (1 - 0.001)); }, 250);
  }

  // ── App → JS bridge ──
  window.freeaiBridge = {
    setPermission: function (state) {
      if (state === perm) return;
      perm = state;
      if (step === 2) render();
    },
    setLaunchState: function (on) {
      launch = !!on;
      if (step === 2) render();
    },
  };

  render();
})();
