#!/usr/bin/env node
// Generate audience-specific landing pages from index.html.
//
// index.html is the single source of truth and the clear base of the site: it
// stays at the repo root (served at `/`) and doubles as the template for every
// audience lander. This script clones it and swaps only the *header* copy — the
// <title>, social/meta tags, the hero <h1>, the .sub line, and the .hero-note
// — plus, when given, the before/after demo's "Stock <tool>"
// card so the page mimics the real thinking indicator of the tool that audience
// uses (e.g. ChatGPT's pulsing dot instead of Claude's asterisk). Everything
// else (advertiser form, install card, script.js) is untouched, so structural
// edits to index.html propagate to every lander on the next `make landers`.
//
// Output is one real static .html file per audience, all under `landers/` to
// keep the repo root tidy. The generator also:
//   • rewrites the shared-asset links (theme.css / styles.css / script.js) to
//     absolute paths so a lander renders correctly from any URL depth;
//   • links the lander-only landers.css (per-tool demo indicators);
//   • adds a <link rel="canonical"> to the short campaign URL;
//   • manages vercel.json so each lander is served at a clean short URL
//     (`/chatgpt` → `landers/chatgpt.html`), one URL per ad campaign.
//
// Only audiences whose AI tool the product serves today — ChatGPT, Claude,
// Gemini (browser) and Claude Code — are generated; Cursor / Copilot /
// Perplexity wait until those integrations ship so a live lander never promises
// something we can't yet deliver (their indicators already exist in landers.css).
//
// No third-party deps. Run `node tools/gen-landers.mjs` or `make landers`.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "web", "landers");
const src = readFileSync(join(root, "web", "index.html"), "utf8");

// ── Reusable advertiser checkout card ───────────────────────────────────────
// The advertiser checkout form lives once, in index.html. The bespoke
// /advertisers page (built below) reuses the exact same markup so the form has a
// single source of truth — we only *read* it out of `src` here, never rewrite
// index.html. We grab the whole `.adv-card` inner (heading + form) so every form
// selector script.js wires up comes along automatically, then apply the two
// advertiser-page tweaks: drop the orange "Advertisers" eyebrow, and swap the
// heading. Each step asserts its anchor so a future copy edit to index.html
// fails the build loudly instead of silently shipping a stale form.
const advMatch = src.match(/<div class="adv-card">([\s\S]*?)<\/div>\s*<\/section>/);
if (!advMatch) {
  throw new Error("gen-landers: .adv-card block not found in index.html");
}
let advCardInner = advMatch[1];
const advNoEyebrow = advCardInner.replace(
  /\s*<span class="eyebrow">Advertisers<\/span>/,
  "",
);
if (advNoEyebrow === advCardInner) {
  throw new Error('gen-landers: advertisers eyebrow anchor not found in .adv-card');
}
const advSwapHeading = advNoEyebrow.replace(
  /<h2>Get your product in front of customers who are already AI-native\.<\/h2>/,
  "<h2>Spend your ad budget where it matters.</h2>",
);
if (advSwapHeading === advNoEyebrow) {
  throw new Error("gen-landers: advertisers heading anchor not found in .adv-card");
}
const advFormVariant = advSwapHeading;

// Reusable "Stock <tool>" demo cards. `label` is the card's eyebrow; `icon` is
// the markup that replaces the default spinning coral asterisk. The classes map
// to indicators in landers.css. Claude is the index.html default, so a lander
// that wants the Claude look simply omits `demo`.
const DEMO = {
  chatgpt: { label: "Stock ChatGPT", icon: '<span class="think think-gpt"></span>' },
  gemini: { label: "Stock Gemini", icon: '<span class="think think-gemini"></span>' },
  claude: { label: "Stock Claude", icon: '<span class="ast">✳</span>' },
};

// Each lander overrides the header copy (and optionally the demo) for one
// audience. `slug` is the output file and, via the vercel.json rewrite, the
// short URL path (`/<slug>`).
const LANDERS = [
  {
    slug: "developers",
    title: "FreeAI.fyi — Get Claude for free while you ship code",
    description:
      "Earn Claude credits while you build with Claude Code, ChatGPT and Gemini. A sponsored line shows while the model thinks — 50% of the revenue comes back to you as credits for Claude.",
    ogTitle: "FreeAI.fyi — Get Claude for free while you ship code",
    ogDescription:
      "50% of the revenue comes back as Claude credits. Bid live for the most-watched spinner on Earth.",
    h1: "Make money while you build.",
    sub:
      "We turned “Discombobulating…” into an ad marketplace. " +
      "<strong>50%</strong> of the revenue comes back to you as " +
      "<span class=\"hl\">Claude monthly plans</span>, reducing your and your friends’ AI spend to $0.",
    heroNote:
      "Works inside <strong>Claude Code, ChatGPT &amp; Gemini</strong> while you build. A " +
      "sponsored line appears while the model thinks — and <strong>50%</strong> of what it earns " +
      "becomes credits you redeem for Claude Pro or Max.",
    // Claude look is the index.html default — no demo override needed.
  },
  {
    slug: "chatgpt",
    title: "FreeAI.fyi — Earn Claude credits while you use ChatGPT",
    description:
      "Already chatting with ChatGPT? A sponsored line shows while it thinks, and 50% of the revenue comes back to you as free Claude credits. Free Chrome extension.",
    ogTitle: "FreeAI.fyi — Earn Claude credits while you use ChatGPT",
    ogDescription:
      "Get paid to use the AI you already use. 50% of the revenue comes back as Claude credits.",
    h1: "Get paid to use ChatGPT.",
    sub:
      "We turned “Thinking…” into an ad marketplace. While <strong>ChatGPT</strong> " +
      "answers, one sponsored line appears — and <strong>50%</strong> of the revenue comes " +
      "back to you as <span class=\"hl\">free Claude credits</span>, reducing your AI spend to $0.",
    heroNote:
      "Works inside <strong>ChatGPT, Claude &amp; Gemini</strong> in your browser. A " +
      "sponsored line appears only while the model thinks — and <strong>50%</strong> of what it earns " +
      "becomes credits you redeem for Claude Pro or Max.",
    demo: DEMO.chatgpt,
  },
  {
    slug: "gemini",
    title: "FreeAI.fyi — Earn Claude credits while you use Gemini",
    description:
      "Use Gemini for work or school? A sponsored line shows while it thinks, and 50% of the revenue comes back to you as free Claude credits. Free Chrome extension.",
    ogTitle: "FreeAI.fyi — Earn Claude credits while you use Gemini",
    ogDescription:
      "Get paid to use Gemini. 50% of the revenue comes back as Claude credits.",
    h1: "Get paid to use Gemini.",
    sub:
      "We turned “Thinking…” into an ad marketplace. While <strong>Gemini</strong> " +
      "answers, one sponsored line appears — and <strong>50%</strong> of the revenue comes " +
      "back to you as <span class=\"hl\">free Claude credits</span>, reducing your AI spend to $0.",
    heroNote:
      "Works inside <strong>Gemini, ChatGPT &amp; Claude</strong> in your browser. A " +
      "sponsored line appears only while the model thinks — and <strong>50%</strong> of what it earns " +
      "becomes credits you redeem for Claude Pro or Max.",
    demo: DEMO.gemini,
  },
  {
    slug: "students",
    title: "FreeAI.fyi — Free AI for students",
    description:
      "Cut your AI spend to $0. Earn Claude credits while you use ChatGPT, Claude and Gemini for class — a sponsored line shows while the AI thinks and 50% comes back to you.",
    ogTitle: "FreeAI.fyi — Free AI for students",
    ogDescription:
      "Stop paying for AI. 50% of the revenue comes back to you as Claude credits — share it with your class.",
    h1: "Free AI for students.",
    sub:
      "Stop paying for AI. A sponsored line shows while <strong>ChatGPT, Claude &amp; " +
      "Gemini</strong> think — and <strong>50%</strong> of the revenue comes back to you as " +
      "<span class=\"hl\">Claude credits</span>, reducing your and your classmates’ AI spend to $0.",
    heroNote:
      "Works inside <strong>ChatGPT, Claude &amp; Gemini</strong> in your browser — free to install. " +
      "A sponsored line appears while the model thinks, and <strong>50%</strong> of what it " +
      "earns becomes credits you redeem for Claude Pro or Max.",
    demo: DEMO.chatgpt,
  },
  {
    slug: "writers",
    title: "FreeAI.fyi — Earn Claude credits while you write with AI",
    description:
      "Draft, edit and brainstorm with ChatGPT, Claude and Gemini — and earn free Claude credits while you do. A sponsored line shows while the AI thinks; 50% comes back to you.",
    ogTitle: "FreeAI.fyi — Earn Claude credits while you write with AI",
    ogDescription:
      "Get paid for the AI you already write with. 50% of the revenue comes back as Claude credits.",
    h1: "Get paid while you write.",
    sub:
      "Every draft, rewrite and outline you run through <strong>ChatGPT, Claude &amp; Gemini</strong> " +
      "shows one sponsored line while it thinks — and <strong>50%</strong> of the revenue comes " +
      "back to you as <span class=\"hl\">free Claude credits</span>.",
    heroNote:
      "Works inside <strong>ChatGPT, Claude &amp; Gemini</strong> in your browser. A " +
      "sponsored line appears only while the model thinks — and <strong>50%</strong> of what it earns " +
      "becomes credits you redeem for Claude Pro or Max.",
    demo: DEMO.chatgpt,
  },
  {
    slug: "researchers",
    title: "FreeAI.fyi — Earn Claude credits while you research with AI",
    description:
      "Run questions through Gemini, ChatGPT and Claude all day? A sponsored line shows while they think, and 50% of the revenue comes back to you as Claude credits.",
    ogTitle: "FreeAI.fyi — Earn Claude credits while you research with AI",
    ogDescription:
      "Turn your AI research habit into Claude credits. 50% of the revenue comes back to you.",
    h1: "Get paid while you research.",
    sub:
      "Every question you run through <strong>Gemini, ChatGPT &amp; Claude</strong> shows one " +
      "sponsored line while it thinks — and <strong>50%</strong> of the revenue comes back to you as " +
      "<span class=\"hl\">Claude credits</span>, cutting your research stack to $0.",
    heroNote:
      "Works inside <strong>Gemini, ChatGPT &amp; Claude</strong> in your browser. A " +
      "sponsored line appears only while the model thinks — and <strong>50%</strong> of what it earns " +
      "becomes credits you redeem for Claude Pro or Max.",
    demo: DEMO.gemini,
  },
  {
    slug: "founders",
    title: "FreeAI.fyi — Cut your startup's AI bill to $0",
    description:
      "Your team runs on Claude, ChatGPT and Gemini. A sponsored line shows while they think, and 50% of the revenue comes back as Claude credits — turning AI spend into runway.",
    ogTitle: "FreeAI.fyi — Cut your startup's AI bill to $0",
    ogDescription:
      "Turn your team's AI spend into runway. 50% of the revenue comes back as Claude credits.",
    h1: "Turn AI spend into runway.",
    sub:
      "Your team already runs on <strong>Claude, ChatGPT &amp; Gemini</strong>. A sponsored " +
      "line shows while they think — and <strong>50%</strong> of the revenue comes back as " +
      "<span class=\"hl\">Claude credits</span>, turning AI spend into runway.",
    heroNote:
      "Works inside <strong>Claude, ChatGPT &amp; Gemini</strong> in your browser. A " +
      "sponsored line appears only while the model thinks — and <strong>50%</strong> of what it earns " +
      "becomes credits your team redeems for Claude Pro or Max.",
    demo: DEMO.claude,
  },
  {
    slug: "marketers",
    title: "FreeAI.fyi — Earn Claude credits while you make content with AI",
    description:
      "Generate campaigns, captions and briefs with ChatGPT, Claude and Gemini — and earn free Claude credits while you do. A sponsored line shows while the AI thinks; 50% comes back.",
    ogTitle: "FreeAI.fyi — Earn Claude credits while you make content with AI",
    ogDescription:
      "Get paid for every AI prompt. 50% of the revenue comes back as Claude credits.",
    h1: "Get paid for every prompt.",
    sub:
      "Every campaign, caption and brief you generate with <strong>ChatGPT, Claude &amp; Gemini</strong> " +
      "shows one sponsored line while it thinks — and <strong>50%</strong> of the revenue comes " +
      "back to you as <span class=\"hl\">free Claude credits</span>.",
    heroNote:
      "Works inside <strong>ChatGPT, Claude &amp; Gemini</strong> in your browser. A " +
      "sponsored line appears only while the model thinks — and <strong>50%</strong> of what it earns " +
      "becomes credits you redeem for Claude Pro or Max.",
    demo: DEMO.chatgpt,
  },
  // NB: `advertisers` is intentionally NOT in this list. Unlike the audience
  // landers (which are index.html clones with swapped hero copy), /advertisers
  // is a bespoke, advertiser-built page assembled by buildAdvertisersPage()
  // below — it reuses only the extracted checkout card (advFormVariant), not the
  // whole homepage layout.
];

// Replace the first match of `re` in `html`, or fail loudly so a copy/markup
// change to index.html can never silently produce a stale lander.
function sub(html, label, re, value) {
  if (!re.test(html)) {
    throw new Error(`gen-landers: anchor not found in index.html: ${label}`);
  }
  return html.replace(re, value);
}

// The bespoke /advertisers <main>. Unlike the audience landers this is NOT the
// homepage layout — it's a lean, advertiser-built page: a text hero, the three
// surfaces advertisers reach, the "what you get" receipt promise, the SAME
// checkout form (reused via advFormVariant — no eyebrow, swapped heading), a
// recurring-budget note, and an advertiser FAQ. It deliberately omits the
// before/after demo, downloads, surfaces screenshots and leaderboard.
//
// Reused styles only: .hero/.sub, .surfaces .wrap/.secthead, .eyebrow,
// .trust/.trust-list, .faq/.faq-item/.faq-q/.faq-a/.faq-lead, .advertisers/
// .adv-card. The only page-specific CSS is .adv-cols and .adv-recurring.
//
// NOTE: the hero uses <p class="sub">, NOT <p class="hero-note"> — script.js's
// initWaitlist() injects a "join waitlist" email widget after any .hero-note,
// which is wrong for an advertiser page. With no .hero-note it cleanly no-ops.
const ADV_MAIN = `<main id="top">
    <!-- HERO -->
    <section class="hero">
      <h1>Get your product in front of customers who are already AI-native.</h1>
      <p class="sub">
        Higher conversion than every other saturated channel.<br /><strong>Lower CPM.</strong>
      </p>
    </section>

    <!-- THE THREE SURFACES ADVERTISERS REACH -->
    <section class="surfaces">
      <div class="wrap">
        <div class="secthead">
          <h2>Get your product seen by buyers who use AI in their workflows.</h2>
        </div>
        <div class="adv-cols">
          <div class="adv-col">
            <span class="idx">01</span>
            <h3>AI in Chrome</h3>
            <p>Beside the thinking spinner in Claude, ChatGPT &amp; Gemini.</p>
          </div>
          <div class="adv-col">
            <span class="idx">02</span>
            <h3>AI in the CLI</h3>
            <p>In the terminal, while Claude Code cooks.</p>
          </div>
          <div class="adv-col">
            <span class="idx">03</span>
            <h3>AI on the desktop</h3>
            <p>Above the composer in the native Mac apps.</p>
          </div>
        </div>
      </div>
    </section>

    <!-- WHAT YOU GET -->
    <section class="trust">
      <span class="eyebrow">What you get</span>
      <h2>We send a customized receipt for every advertiser.</h2>
      <ul class="trust-list">
        <li><strong>CPM report</strong> — where your ad was seen.</li>
        <li><strong>CPC report</strong> — clicks, and where they clicked from.</li>
        <li><strong>Ad performance</strong> — impressions, CTR and spend pacing.</li>
      </ul>
    </section>

    <!-- ADVERTISER CHECKOUT — the exact homepage form (advFormVariant): same
         fields + script.js wiring, only the eyebrow dropped and heading swapped. -->
    <section id="advertisers" class="advertisers">
      <div class="adv-card">${advFormVariant}</div>
      <p class="adv-recurring">
        Want a recurring budget? Reach out to <a href="mailto:ads@contact.freeai.fyi">ads@contact.freeai.fyi</a>.
      </p>
    </section>

    <!-- FAQ -->
    <section class="faq" id="faq">
      <span class="eyebrow">FAQ</span>
      <h2>Questions advertisers ask.</h2>

      <details class="faq-item">
        <summary class="faq-q">Where do my ads show?</summary>
        <div class="faq-a">
          <p class="faq-lead">On the sponsored line that appears while Claude, ChatGPT and Gemini think — in the Chrome extension, in the terminal beside Claude Code, and above the composer in the native Mac apps. It's the one moment every AI user is staring at the screen.</p>
        </div>
      </details>

      <details class="faq-item">
        <summary class="faq-q">How does pricing work?</summary>
        <div class="faq-a">
          <p class="faq-lead">It's a live CPM auction. You set a budget and a CPM (cost per 1,000 impressions) and receive <strong>budget &times; 1,000 &divide; CPM</strong> impressions. The highest CPM serves first — outbid the current top to take the #1 slot, or bid the floor to join the queue.</p>
        </div>
      </details>

      <details class="faq-item">
        <summary class="faq-q">Am I billed per impression or per click?</summary>
        <div class="faq-a">
          <p class="faq-lead">Per impression — clicks are a bonus. Your receipt breaks out both: a <strong>CPM report</strong> of where the ad was seen and a <strong>CPC report</strong> of where the clicks came from.</p>
        </div>
      </details>

      <details class="faq-item">
        <summary class="faq-q">How do I pay?</summary>
        <div class="faq-a">
          <p class="faq-lead">Checkout runs through Stripe. Fill in the form, hit <strong>Pay with Stripe</strong>, and you're redirected to a secure Stripe Checkout page. Your campaign goes live once payment clears.</p>
        </div>
      </details>

      <details class="faq-item">
        <summary class="faq-q">Can I run a recurring or always-on budget?</summary>
        <div class="faq-a">
          <p class="faq-lead">The self-serve form funds a single campaign. For a recurring monthly budget, managed pacing, or a guaranteed top slot, email <a href="mailto:ads@contact.freeai.fyi">ads@contact.freeai.fyi</a> and we'll set it up.</p>
        </div>
      </details>

      <details class="faq-item">
        <summary class="faq-q">What's the inventory, and can I target it?</summary>
        <div class="faq-a">
          <p class="faq-lead">Inventory is every "thinking" moment across Claude, ChatGPT and Gemini — in the browser, the CLI and the desktop. Today you control budget, CPM (placement priority) and creative (line, color, link); finer surface and audience targeting is on the roadmap — ask us if you need it now.</p>
        </div>
      </details>
    </section>
  </main>`;

// Build the bespoke /advertisers page: same <head> machinery as the lander loop
// (absolutized assets + per-page meta), then swap the whole homepage <main> for
// ADV_MAIN. index.html is only read here — never rewritten — so the homepage and
// every other lander keep the original checkout form byte-for-byte.
function buildAdvertisersPage() {
  let out = src;

  // landers.css link + absolutize shared assets (mirrors the lander loop).
  out = sub(
    out,
    "styles.css link",
    /(<link rel="stylesheet" href="styles\.css\?v=[^"]*" \/>)/,
    `$1\n  <link rel="stylesheet" href="/landers/landers.css?v=20260620a" />`,
  );
  out = out
    .replace(/href="theme\.css/g, 'href="/theme.css')
    .replace(/href="styles\.css/g, 'href="/styles.css')
    .replace(/src="script\.js/g, 'src="/script.js');

  const title = "FreeAI.fyi — Advertise where AI-native customers already are";
  const description =
    "Get your product in front of customers who are already AI-native. Higher conversion than every saturated channel, lower CPM. Bid on the sponsored line shown while Claude, ChatGPT and Gemini think.";
  out = sub(out, "title", /<title>[\s\S]*?<\/title>/, `<title>${title}</title>`);
  out = sub(
    out,
    "meta description",
    /<meta name="description" content="[\s\S]*?" \/>/,
    `<meta name="description" content="${description}" />`,
  );
  out = sub(
    out,
    "og:title",
    /<meta property="og:title" content="[\s\S]*?" \/>/,
    `<meta property="og:title" content="${title}" />`,
  );
  out = sub(
    out,
    "og:description",
    /<meta property="og:description" content="[\s\S]*?" \/>/,
    `<meta property="og:description" content="${description}" />`,
  );
  out = sub(
    out,
    "twitter:title",
    /<meta name="twitter:title" content="[\s\S]*?" \/>/,
    `<meta name="twitter:title" content="${title}" />`,
  );
  out = sub(
    out,
    "twitter:description",
    /<meta name="twitter:description" content="[\s\S]*?" \/>/,
    `<meta name="twitter:description" content="${description}" />`,
  );
  out = sub(
    out,
    "og:url",
    /<meta property="og:url" content="[\s\S]*?" \/>/,
    `<meta property="og:url" content="https://freeai.fyi/advertisers" />`,
  );
  out = sub(
    out,
    "canonical",
    /<link rel="canonical" href="[\s\S]*?" \/>/,
    `<link rel="canonical" href="https://freeai.fyi/advertisers" />`,
  );

  out = out.replace(/<body>/, `<body data-lander="advertisers">`);
  out = sub(out, "main", /<main id="top">[\s\S]*?<\/main>/, ADV_MAIN);
  return out;
}

mkdirSync(outDir, { recursive: true });

// Collected for landers/landers.json — the manifest the admin "Landers" tab
// reads so the list there always matches what's actually generated here.
const manifest = [];

let written = 0;
for (const l of LANDERS) {
  let out = src;

  // Link the lander-only stylesheet (per-tool demo indicators) right after the
  // shared styles.css link — matched on its original relative form, before the
  // asset paths below are absolutized.
  out = sub(
    out,
    "styles.css link",
    /(<link rel="stylesheet" href="styles\.css\?v=[^"]*" \/>)/,
    `$1\n  <link rel="stylesheet" href="/landers/landers.css?v=20260620a" />`,
  );

  // Landers live under /landers/, so make the shared-asset links absolute —
  // they'd otherwise resolve against the lander's path and 404.
  out = out
    .replace(/href="theme\.css/g, 'href="/theme.css')
    .replace(/href="styles\.css/g, 'href="/styles.css')
    .replace(/src="script\.js/g, 'src="/script.js');

  out = sub(out, "title", /<title>[\s\S]*?<\/title>/, `<title>${l.title}</title>`);
  out = sub(
    out,
    "meta description",
    /<meta name="description" content="[\s\S]*?" \/>/,
    `<meta name="description" content="${l.description}" />`,
  );
  out = sub(
    out,
    "og:title",
    /<meta property="og:title" content="[\s\S]*?" \/>/,
    `<meta property="og:title" content="${l.ogTitle}" />`,
  );
  out = sub(
    out,
    "og:description",
    /<meta property="og:description" content="[\s\S]*?" \/>/,
    `<meta property="og:description" content="${l.ogDescription}" />`,
  );
  // Twitter title/description mirror the OG copy (the share image is shared).
  out = sub(
    out,
    "twitter:title",
    /<meta name="twitter:title" content="[\s\S]*?" \/>/,
    `<meta name="twitter:title" content="${l.ogTitle}" />`,
  );
  out = sub(
    out,
    "twitter:description",
    /<meta name="twitter:description" content="[\s\S]*?" \/>/,
    `<meta name="twitter:description" content="${l.ogDescription}" />`,
  );
  // Point og:url + the canonical at this lander's short campaign URL, so shares
  // and search both resolve to /chatgpt rather than the homepage.
  out = sub(
    out,
    "og:url",
    /<meta property="og:url" content="[\s\S]*?" \/>/,
    `<meta property="og:url" content="https://freeai.fyi/${l.slug}" />`,
  );
  out = sub(
    out,
    "canonical",
    /<link rel="canonical" href="[\s\S]*?" \/>/,
    `<link rel="canonical" href="https://freeai.fyi/${l.slug}" />`,
  );
  out = sub(out, "hero h1", /<h1>[\s\S]*?<\/h1>/, `<h1>${l.h1}</h1>`);
  out = sub(
    out,
    "hero .sub",
    /<p class="sub">[\s\S]*?<\/p>/,
    `<p class="sub">\n        ${l.sub}\n      </p>`,
  );
  out = sub(
    out,
    "hero .hero-note",
    /<p class="hero-note">[\s\S]*?<\/p>/,
    `<p class="hero-note">\n        ${l.heroNote}\n      </p>`,
  );
  // Optional: make the "Stock <tool>" demo card mimic this audience's tool.
  if (l.demo) {
    out = sub(
      out,
      "demo-label",
      /<span class="demo-label">Stock spinner<\/span>/,
      `<span class="demo-label">${l.demo.label}</span>`,
    );
    out = sub(out, "demo think-icon", /<span class="ast">✳<\/span>/, l.demo.icon);
  }

  // Mark which lander rendered, for debugging and analytics segmentation.
  out = out.replace(/<body>/, `<body data-lander="${l.slug}">`);

  writeFileSync(join(outDir, `${l.slug}.html`), out);
  written++;
  manifest.push({
    slug: l.slug,
    url: `/${l.slug}`,
    headline: l.h1,
    title: l.title,
    // The "Stock <tool>" the before/after demo mimics; Claude is the default.
    tool: l.demo ? l.demo.label.replace(/^Stock\s+/, "") : "Claude",
  });
  console.log(`  wrote landers/${l.slug}.html`);
}

// Bespoke /advertisers page — built separately (not an index.html clone) but
// still emitted to landers/ and listed in the manifest + vercel rewrites.
writeFileSync(join(outDir, "advertisers.html"), buildAdvertisersPage());
written++;
manifest.push({
  slug: "advertisers",
  url: "/advertisers",
  headline: "Get your product in front of customers who are already AI-native.",
  title: "FreeAI.fyi — Advertise where AI-native customers already are",
  tool: "Advertisers",
});
console.log("  wrote landers/advertisers.html (bespoke)");

// Manifest for the admin "Landers" tab (and anything else that wants the list).
writeFileSync(join(outDir, "landers.json"), JSON.stringify(manifest, null, 2) + "\n");

// Keep vercel.json's lander rewrites in sync with the LANDERS list above, so
// each campaign is served at a clean short URL (`/chatgpt`). Non-lander
// rewrites (e.g. the api.freeai.fyi proxy) are preserved untouched.
const vercelPath = join(root, "web", "vercel.json");
const vercel = JSON.parse(readFileSync(vercelPath, "utf8"));
const isLanderRewrite = (r) =>
  typeof r?.destination === "string" && r.destination.startsWith("/landers/");
const preserved = (vercel.rewrites || []).filter((r) => !isLanderRewrite(r));
const landerRewrites = [
  ...LANDERS.map((l) => ({
    source: `/${l.slug}`,
    destination: `/landers/${l.slug}`,
  })),
  // /advertisers is bespoke (not in LANDERS) but still served from landers/.
  { source: "/advertisers", destination: "/landers/advertisers" },
];
vercel.rewrites = [...preserved, ...landerRewrites];
writeFileSync(vercelPath, JSON.stringify(vercel, null, 2) + "\n");

console.log(
  `gen-landers: generated ${written} landing page(s) → web/landers/, and synced ${landerRewrites.length} rewrite(s) in vercel.json`,
);
