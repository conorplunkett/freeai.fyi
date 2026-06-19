// Shared ad inventory — the live "bid market".
// Attached to globalThis so it works in content scripts, the popup, and the
// service worker (via importScripts). In production these come from the auction.
(function (g) {
  g.BB_ADS = [
    { brand: "Fluidstack", chip: "F", color: "#1d6cff", ink: "#fff", line: "Fluidstack — building 10GW of compute. Join us.", url: "https://freeai.fyi/go/fluidstack", cat: "infra" },
    { brand: "Ramp", chip: "R", color: "#ffd54a", ink: "#1b1e25", line: "Ramp · save time and money", url: "https://freeai.fyi/go/ramp", cat: "finance" },
    { brand: "Linear", chip: "L", color: "#5b5bd6", ink: "#fff", line: "Linear — issue tracking built for speed", url: "https://freeai.fyi/go/linear", cat: "devtools" },
    { brand: "Tuple", chip: "T", color: "#7c3aed", ink: "#fff", line: "Pair with Tuple — how developers build taste", url: "https://freeai.fyi/go/tuple", cat: "devtools" },
    { brand: "Vercel", chip: "△", color: "#000", ink: "#fff", line: "Vercel · ship your agent to prod", url: "https://freeai.fyi/go/vercel", cat: "infra" },
    { brand: "Neon", chip: "N", color: "#00e599", ink: "#04130a", line: "Neon · Postgres your agent can branch", url: "https://freeai.fyi/go/neon", cat: "infra" },
    { brand: "Resend", chip: "R", color: "#111", ink: "#fff", line: "Resend — email for developers", url: "https://freeai.fyi/go/resend", cat: "devtools" },
    { brand: "querybear", chip: "Q", color: "#f59e0b", ink: "#1b1e25", line: "querybear.com — Talk to your database with MCP.", url: "https://freeai.fyi/go/querybear", cat: "devtools" },
    { brand: "Solo", chip: "S", color: "#0ea5e9", ink: "#fff", line: "Solo — a better place to run your agents", url: "https://freeai.fyi/go/solo", cat: "infra" },
    { brand: "Liner", chip: "L", color: "#10b981", ink: "#fff", line: "Liner Search — The most performant & affordable", url: "https://freeai.fyi/go/liner", cat: "ai" }
  ];

  // The mock ad shown in Test Mode. Deliberately obvious so it can never be
  // mistaken for real, billable inventory. Clicking it opens the FreeAI test
  // page instead of an advertiser URL.
  g.BB_MOCK_AD = {
    brand: "FreeAI Test",
    chip: "✓",
    color: "#d97757", // FreeAI brand coral (--accent) — our own test ad, not a sponsor
    ink: "#fff",
    line: "Test ad — this is what advertisers will see here.",
    url: "https://freeai.fyi/?test=1",
    cat: "test",
    mock: true
  };
})(typeof self !== "undefined" ? self : window);
