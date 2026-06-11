// Shared ad inventory — the live "bid market".
// Attached to globalThis so it works in content scripts, the popup, and the
// service worker (via importScripts). In production these come from the auction.
(function (g) {
  g.BB_ADS = [
    { brand: "Fluidstack", chip: "F", color: "#1d6cff", ink: "#fff", line: "Fluidstack — building 10GW of compute. Join us.", url: "https://betterbacks.ai/go/fluidstack", cat: "infra" },
    { brand: "Ramp", chip: "R", color: "#ffd54a", ink: "#1b1e25", line: "Ramp · save time and money", url: "https://betterbacks.ai/go/ramp", cat: "finance" },
    { brand: "Linear", chip: "L", color: "#5b5bd6", ink: "#fff", line: "Linear — issue tracking built for speed", url: "https://betterbacks.ai/go/linear", cat: "devtools" },
    { brand: "Tuple", chip: "T", color: "#7c3aed", ink: "#fff", line: "Pair with Tuple — how developers build taste", url: "https://betterbacks.ai/go/tuple", cat: "devtools" },
    { brand: "Vercel", chip: "△", color: "#000", ink: "#fff", line: "Vercel · ship your agent to prod", url: "https://betterbacks.ai/go/vercel", cat: "infra" },
    { brand: "Neon", chip: "N", color: "#00e599", ink: "#04130a", line: "Neon · Postgres your agent can branch", url: "https://betterbacks.ai/go/neon", cat: "infra" },
    { brand: "Resend", chip: "R", color: "#111", ink: "#fff", line: "Resend — email for developers", url: "https://betterbacks.ai/go/resend", cat: "devtools" },
    { brand: "querybear", chip: "Q", color: "#f59e0b", ink: "#1b1e25", line: "querybear.com — Talk to your database with MCP.", url: "https://betterbacks.ai/go/querybear", cat: "devtools" },
    { brand: "Solo", chip: "S", color: "#0ea5e9", ink: "#fff", line: "Solo — a better place to run your agents", url: "https://betterbacks.ai/go/solo", cat: "infra" },
    { brand: "Liner", chip: "L", color: "#10b981", ink: "#fff", line: "Liner Search — The most performant & affordable", url: "https://betterbacks.ai/go/liner", cat: "ai" }
  ];
})(typeof self !== "undefined" ? self : window);
