/* FreeAI admin dashboard.
 *
 * Auth model: the ADMIN_KEY is the password. It's remembered in localStorage so
 * you only enter it once per browser (never re-typed), and sent as the
 * `x-admin-key` header on every request. No data renders until a valid key
 * unlocks the gate; the server re-validates the key on every endpoint, so this
 * static page exposes nothing on its own — the financial API stays protected
 * even though the page never nags you for a password. */

const API_BASE = (
  document.querySelector('meta[name="freeai-api"]')?.content ||
  "https://wpjfhezklpczxzocgxsb.supabase.co/functions/v1/api"
).replace(/\/+$/, "");

const KEY_STORE = "freeai_admin_key";
const getKey = () => localStorage.getItem(KEY_STORE) || "";
const setKey = (k) => localStorage.setItem(KEY_STORE, k);
const clearKey = () => localStorage.removeItem(KEY_STORE);

// ── tiny DOM + format helpers ──────────────────────────────────────────────
const $ = (sel, root = document) => root.querySelector(sel);
function h(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === "class") e.className = v;
    else if (k === "html") e.innerHTML = v;
    else if (k.startsWith("on") && typeof v === "function") e.addEventListener(k.slice(2), v);
    else if (k === "dataset") Object.assign(e.dataset, v);
    else e.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat()) { if (kid == null) continue; e.append(kid.nodeType ? kid : document.createTextNode(String(kid))); }
  return e;
}
const usd = (n) => "$" + (Number(n) || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const usd0 = (n) => "$" + Math.round(Number(n) || 0).toLocaleString("en-US"); // whole-dollar (CPM)
const num = (n) => (Number(n) || 0).toLocaleString("en-US");
const dt = (s) => (s ? new Date(s).toLocaleString() : "—");
const dShort = (s) => (s ? new Date(s).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "—");
const short = (s, n = 10) => (s ? String(s).slice(0, n) + "…" : "—");

let toastTimer;
function toast(msg, isErr = false) {
  const t = $("#toast");
  t.textContent = msg; t.className = "toast" + (isErr ? " err" : ""); t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), 2600);
}

// ── API ─────────────────────────────────────────────────────────────────────
async function api(path, { method = "GET", body } = {}) {
  const sentKey = getKey();
  const res = await fetch(API_BASE + path, {
    method,
    headers: { "x-admin-key": sentKey, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) {
    // Only react if the key that failed is still the active one — a stale,
    // in-flight request from an old key must not clobber a key the user just set.
    if (getKey() === sentKey) { clearKey(); showGate("Key rejected. Enter it again."); }
    throw new Error("unauthorized");
  }
  if (!res.ok) { let m = res.status; try { m = (await res.json()).error || m; } catch {} throw new Error(String(m)); }
  return res.json();
}
// Soft variant for optional sections: returns null instead of throwing, so a
// not-yet-deployed endpoint degrades to a placeholder rather than breaking a tab.
async function tryApi(path) { try { return await api(path); } catch { return null; } }
function soonCard(title) {
  return h("div", { class: "card" }, h("div", { class: "card-head" }, h("h2", {}, title)),
    h("p", { class: "empty" }, "Not available yet — this section’s API update is still deploying."));
}

// ── login gate ────────────────────────────────────────────────────────────
// Inline display is set explicitly (not just the `hidden` attribute) so a
// stale/cached stylesheet can never leave the app shell showing behind the gate.
function showGate(err) {
  const a = $("#app"), g = $("#gate");
  a.hidden = true; a.style.display = "none";
  g.hidden = false; g.style.display = "";
  $("#view").innerHTML = ""; current = null; // drop any half-rendered tab content
  const e = $("#gate-err");
  if (err) { e.textContent = err; e.hidden = false; } else e.hidden = true;
  const f = $("#gate-key"); if (err) f.value = ""; f.focus();
}
function showApp() {
  const a = $("#app"), g = $("#gate");
  g.hidden = true; g.style.display = "none";
  a.hidden = false; a.style.display = "";
}

// Validate a key without persisting it — a wrong key must never get stored.
async function tryKey(k) {
  try {
    const res = await fetch(API_BASE + "/v1/admin/overview", { headers: { "x-admin-key": k } });
    return res.ok;
  } catch { return false; }
}

$("#gate-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const k = $("#gate-key").value.trim();
  if (!k) return;
  const btn = ev.submitter || $("#gate-form button[type=submit]");
  if (btn) { btn.disabled = true; btn.textContent = "Checking…"; }
  if (await tryKey(k)) { setKey(k); showApp(); route(true); }
  else { showGate("Key rejected. Enter it again."); }
  if (btn) { btn.disabled = false; btn.textContent = "Unlock"; }
});
$("#logout").addEventListener("click", () => { clearKey(); location.hash = ""; showGate(); });
$("#refresh").addEventListener("click", () => route(true));

// ── tabs / router ───────────────────────────────────────────────────────────
const TABS = [
  { id: "overview", label: "Overview", render: renderOverview },
  { id: "daily", label: "Daily Metrics", render: renderDaily },
  { id: "ads", label: "Ads", render: renderAds },
  { id: "redemptions", label: "Redemptions", render: renderRedemptions },
  { id: "income", label: "Income", render: renderIncome },
  { id: "users", label: "Users", render: renderUsers },
  { id: "emails", label: "Emails", render: renderEmails },
  { id: "payouts", label: "Payouts", render: renderPayouts },
  { id: "referrals", label: "Referrals", render: renderReferrals },
  { id: "affiliates", label: "Affiliates", render: renderAffiliates },
  { id: "waitlist", label: "Waitlist", render: renderWaitlist },
  { id: "landers", label: "Landers", render: renderLanders },
  { id: "devices", label: "Devices & Fraud", render: renderDevices },
  { id: "schema", label: "Schema", render: renderSchema },
  { id: "settings", label: "Settings", render: renderSettings },
];

function buildNav() {
  const nav = $("#nav"); nav.innerHTML = "";
  for (const t of TABS) {
    nav.append(h("button", { dataset: { tab: t.id }, onclick: () => (location.hash = t.id) },
      h("span", {}, t.label), h("span", { class: "dot", id: `nav-dot-${t.id}`, hidden: true })));
  }
}
function setActiveNav(id) {
  document.querySelectorAll("#nav button").forEach((b) => b.classList.toggle("active", b.dataset.tab === id));
}
function navDot(id, n) {
  const d = $(`#nav-dot-${id}`); if (!d) return;
  if (n) { d.textContent = n; d.hidden = false; } else d.hidden = true;
}

let current;
async function route(force) {
  if (!getKey()) return showGate();
  const id = (location.hash.replace("#", "") || "overview");
  const tab = TABS.find((t) => t.id === id) || TABS[0];
  if (current === tab.id && !force) return;
  current = tab.id;
  setActiveNav(tab.id);
  $("#page-title").textContent = tab.label;
  const view = $("#view");
  view.innerHTML = '<div class="loading">Loading…</div>';
  try { await tab.render(view); }
  catch (err) { view.innerHTML = ""; view.append(h("div", { class: "empty" }, "Couldn’t load: " + err.message)); }
}
window.addEventListener("hashchange", () => route());

// ── shared render helpers ────────────────────────────────────────────────────
function tiles(items) {
  return h("div", { class: "tiles" }, items.map((it) =>
    h("div", { class: "tile" + (it.accent ? " accent" : "") },
      h("div", { class: "k" }, it.k), h("div", { class: "v" }, it.v), it.s ? h("div", { class: "s" }, it.s) : null)));
}
function table(cols, rows, rowFn) {
  if (!rows.length) return h("div", { class: "tbl-wrap" }, h("div", { class: "empty" }, "Nothing here yet."));
  const thead = h("tr", {}, cols.map((c) => h("th", { class: c.num ? "num" : null }, c.label)));
  const body = rows.map((r, i) => h("tr", {}, rowFn(r, i).map((cell, ci) =>
    cell && cell.__td ? cell.node : h("td", { class: cols[ci]?.num ? "num" : null }, cell))));
  return h("div", { class: "tbl-wrap" }, h("table", {}, h("thead", {}, thead), h("tbody", {}, body)));
}
const td = (node, cls) => ({ __td: true, node: h("td", { class: cls || null }, node) });
const badge = (s) => h("span", { class: "badge " + (s || "") }, (s || "—").replace(/_/g, " "));
function barChart(data, valueKey, alt) {
  const max = Math.max(1, ...data.map((d) => Number(d[valueKey]) || 0));
  return h("div", {},
    h("div", { class: "chart" }, data.map((d) => {
      const v = Number(d[valueKey]) || 0;
      return h("div", { class: "bar" + (alt ? " alt" : ""), style: `height:${(v / max) * 100}%`, title: `${d.date}: ${valueKey.includes("Usd") ? usd(v) : num(v)}` });
    })),
    h("div", { class: "chart-axis" }, h("span", {}, data[0]?.date || ""), h("span", {}, data[data.length - 1]?.date || "")));
}

// ── tabs ──────────────────────────────────────────────────────────────────
async function renderOverview(view) {
  const d = await api("/v1/admin/overview");
  const r = d.revenue, c = d.counts;
  navDot("ads", c.campaigns_pending);
  navDot("redemptions", c.redemptions_pending);
  setServePill(d.serving);
  view.innerHTML = "";
  view.append(tiles([
    { k: "Outstanding liability", v: usd(r.outstandingLiabilityUsd), s: "owed to users (credits)", accent: true },
    { k: "Platform revenue", v: usd(r.platformFeeUsd), s: "your 10% fees" },
    { k: "Ads purchased", v: usd(r.adsPurchasedUsd), s: usd(r.refundedUsd) + " refunded" },
    { k: "Paid out", v: usd(r.paidOutUsd), s: "to developers" },
    { k: "Redeemed", v: usd(r.redeemedUsd), s: "gift cards" },
    { k: "Pending redemptions", v: usd(d.pendingRedemptionsUsd), s: c.redemptions_pending + " to send" },
    { k: "Users", v: num(c.users), s: num(c.users_with_email) + " with email" },
    { k: "Devices", v: num(c.devices), s: num(c.devices_active_1d) + " active 24h" },
    { k: "Active ads", v: num(c.campaigns_active), s: num(c.campaigns_pending) + " awaiting review" },
    { k: "Impressions", v: num(c.impressions), s: num(c.clicks) + " clicks" },
    { k: "Advertisers", v: num(c.advertisers) },
    { k: "Referrals", v: num(c.referrals) },
  ]));
  view.append(h("div", { class: "card" },
    h("div", { class: "card-head" }, h("h2", {}, "Campaigns by status")),
    table([{ label: "Status" }, { label: "Count", num: true }], d.campaignsByStatus,
      (s) => [badge(s.status), num(s.n)])));
}

async function renderDaily(view) {
  view.innerHTML = "";
  const head = h("div", { class: "card-head" }, h("h2", {}, "Daily metrics"),
    h("div", { class: "row-gap", id: "daily-range" }));
  const body = h("div", {});
  const card = h("div", { class: "card" }, head, body);
  view.append(card);
  let days = 30;
  const load = async () => {
    body.innerHTML = '<div class="loading">Loading…</div>';
    const { series } = await api("/v1/admin/metrics/daily?days=" + days);
    body.innerHTML = "";
    const totals = series.reduce((a, r) => {
      a.imp += r.impressions; a.clk += r.clicks; a.rev += r.recognizedUsd; a.bought += r.adsPurchasedUsd;
      a.dev += r.developerCreditUsd; a.red += r.redemptionsUsd; a.nd += r.newDevices; a.nu += r.newUsers; return a;
    }, { imp: 0, clk: 0, rev: 0, bought: 0, dev: 0, red: 0, nd: 0, nu: 0 });
    body.append(tiles([
      { k: `Impressions (${days}d)`, v: num(totals.imp), s: num(totals.clk) + " clicks" },
      { k: "Revenue recognized", v: usd(totals.rev), s: "fees + dev credit" },
      { k: "Ads purchased", v: usd(totals.bought) },
      { k: "New devices", v: num(totals.nd), s: num(totals.nu) + " new users" },
      { k: "Redeemed", v: usd(totals.red) },
    ]));
    body.append(h("div", { class: "hint", style: "margin:6px 0" }, "Impressions / day"));
    body.append(barChart(series, "impressions"));
    body.append(h("div", { class: "hint", style: "margin:16px 0 6px" }, "Revenue recognized / day"));
    body.append(barChart(series, "recognizedUsd", true));
    const cols = [
      { label: "Date" }, { label: "Impr", num: true }, { label: "Clicks", num: true },
      { label: "Eff. CPM", num: true }, { label: "Recognized", num: true }, { label: "Ads bought", num: true },
      { label: "Dev credit", num: true }, { label: "New dev", num: true }, { label: "New usr", num: true },
      { label: "Redeem #", num: true }, { label: "Redeem $", num: true },
    ];
    const rev = series.slice().reverse();
    body.append(h("div", { style: "margin-top:18px" }, table(cols, rev, (r) => [
      r.date, num(r.impressions), num(r.clicks), usd0(r.effectiveCpmUsd), usd(r.recognizedUsd), usd(r.adsPurchasedUsd),
      usd(r.developerCreditUsd), num(r.newDevices), num(r.newUsers), num(r.redemptions), usd(r.redemptionsUsd),
    ])));
  };
  [7, 30, 90].forEach((n) => $("#daily-range", view).append(
    h("button", { class: "btn btn-sm" + (n === days ? " btn-accent" : ""), onclick: async (e) => {
      days = n; $("#daily-range", view).querySelectorAll("button").forEach((b) => b.classList.remove("btn-accent"));
      e.target.classList.add("btn-accent"); await load();
    } }, n + "d")));
  await load();
}

async function renderAds(view) {
  view.innerHTML = "";
  const filter = h("select", { id: "ad-status" },
    ["", "pending_review", "active", "pending_payment", "exhausted", "rejected", "cancelled"].map((s) =>
      h("option", { value: s }, s ? s.replace(/_/g, " ") : "all statuses")));
  const head = h("div", { class: "card-head" }, h("h2", {}, "Campaigns"), h("div", { class: "row-gap" }, filter));
  const body = h("div", {});
  view.append(h("div", { class: "card" }, head, body));
  const load = async () => {
    body.innerHTML = '<div class="loading">Loading…</div>';
    const status = filter.value;
    const { campaigns } = await api("/v1/admin/campaigns/all" + (status ? "?status=" + status : ""));
    navDot("ads", campaigns.filter((c) => c.status === "pending_review").length || null);
    body.innerHTML = "";
    body.append(table([
      { label: "Brand" }, { label: "Ad line" }, { label: "Status" }, { label: "Bid", num: true },
      { label: "Served / total", num: true }, { label: "Recognized", num: true }, { label: "Advertiser" },
      { label: "Created" }, { label: "" },
    ], campaigns, (c) => [
      c.brand || "—",
      td(h("a", { href: c.url, target: "_blank", rel: "noopener nofollow" }, c.adLine), "wrap"),
      td(badge(c.status)),
      usd(c.bidUsd) + " ×" + c.blocks,
      num(c.impressionsServed) + " / " + num(c.impressionsTotal),
      usd(c.recognizedUsd),
      td(h("span", { class: "mono" }, c.advertiserEmail || "—")),
      dShort(c.createdAt),
      td(adActions(c, load)),
    ]));
  };
  filter.addEventListener("change", load);
  await load();
}
function adActions(c, reload) {
  const wrap = h("div", { class: "actions" });
  if (c.status === "pending_review") {
    wrap.append(h("button", { class: "btn btn-sm btn-accent", onclick: async () => {
      await api("/v1/admin/campaigns/approve", { method: "POST", body: { campaignId: c.id } }); toast("Approved"); reload();
    } }, "Approve"));
    wrap.append(h("button", { class: "btn btn-sm btn-danger", onclick: async () => {
      const note = prompt("Reject reason (optional) — the advertiser is refunded:") ?? null;
      await api("/v1/admin/campaigns/reject", { method: "POST", body: { campaignId: c.id, note } }); toast("Rejected & refunded"); reload();
    } }, "Reject"));
  } else if (["active", "pending_payment"].includes(c.status)) {
    wrap.append(h("button", { class: "btn btn-sm btn-danger", onclick: async () => {
      if (!confirm("Cancel this campaign? It stops serving.")) return;
      await api("/v1/admin/campaigns/cancel", { method: "POST", body: { campaignId: c.id } }); toast("Cancelled"); reload();
    } }, "Cancel"));
  } else { wrap.append(h("span", { class: "muted" }, "—")); }
  return wrap;
}

async function renderRedemptions(view) {
  view.innerHTML = "";
  const filter = h("select", { id: "red-status" },
    ["", "pending", "fulfilled", "cancelled"].map((s) => h("option", { value: s }, s || "all statuses")));
  const body = h("div", {});
  view.append(h("div", { class: "card" },
    h("div", { class: "card-head" }, h("h2", {}, "Claude gift redemptions"),
      h("p", { class: "hint" }, "Mark each one sent once you’ve delivered the gift card."), h("div", { class: "row-gap" }, filter)),
    body));
  const load = async () => {
    body.innerHTML = '<div class="loading">Loading…</div>';
    const { redemptions } = await api("/v1/admin/redemptions" + (filter.value ? "?status=" + filter.value : ""));
    navDot("redemptions", redemptions.filter((r) => r.status === "pending").length || null);
    body.innerHTML = "";
    body.append(table([
      { label: "Created" }, { label: "Recipient" }, { label: "User" }, { label: "Plan" },
      { label: "Months", num: true }, { label: "Amount", num: true }, { label: "Status" }, { label: "Action" },
    ], redemptions, (r) => [
      dt(r.createdAt),
      td(h("span", { class: "mono" }, r.recipientEmail)),
      td(h("span", { class: "mono muted" }, r.userEmail || "—")),
      r.plan, r.months, usd(r.amountUsd), td(badge(r.status)), td(redemptionActions(r, load)),
    ]));
  };
  filter.addEventListener("change", load);
  await load();
}
function redemptionActions(r, reload) {
  const wrap = h("div", { class: "actions" });
  const set = async (status, refund) => {
    await api("/v1/admin/redemptions/status", { method: "POST", body: { id: r.id, status, refund } });
    toast(status === "fulfilled" ? "Marked sent" : "Updated"); reload();
  };
  if (r.status !== "fulfilled") wrap.append(h("button", { class: "btn btn-sm btn-accent", onclick: () => set("fulfilled", false) }, "Mark sent"));
  if (r.status === "fulfilled") wrap.append(h("button", { class: "btn btn-sm", onclick: () => set("pending", false) }, "Un-send"));
  if (r.status !== "cancelled") wrap.append(h("button", { class: "btn btn-sm btn-danger", onclick: () => {
    if (!confirm("Cancel this redemption?")) return;
    const refund = confirm("Refund the credits back to the user’s balance?");
    set("cancelled", refund);
  } }, "Cancel"));
  return wrap;
}

async function renderIncome(view) {
  const { byType } = await api("/v1/admin/income");
  view.innerHTML = "";
  const sum = (types) => byType.filter((r) => types.includes(r.entryType)).reduce((a, r) => a + r.totalUsd, 0);
  view.append(tiles([
    { k: "Ad purchases", v: usd(sum(["campaign_credit"])), accent: true },
    { k: "Platform fees", v: usd(sum(["platform_fee"])), s: "your revenue" },
    { k: "Developer credit", v: usd(sum(["impression_credit", "click_credit"])) },
    { k: "Referral credit", v: usd(sum(["referral_credit"])) },
    { k: "Affiliate credit", v: usd(sum(["affiliate_credit"])) },
    { k: "Paid out", v: usd(-sum(["payout_debit"])) },
    { k: "Redeemed", v: usd(-sum(["gift_redemption_debit"])) },
    { k: "Admin adjustments", v: usd(sum(["admin_credit", "admin_debit"])) },
    { k: "Refunds", v: usd(-sum(["campaign_refund"])) },
  ]));
  view.append(h("div", { class: "card" },
    h("div", { class: "card-head" }, h("h2", {}, "Ledger by entry type"),
      h("p", { class: "hint" }, "Every money movement, summed. Credits positive, debits negative.")),
    table([{ label: "Entry type" }, { label: "Count", num: true }, { label: "Total", num: true }], byType,
      (r) => [h("span", { class: "mono" }, r.entryType), num(r.count), usd(r.totalUsd)])));
}

async function renderUsers(view) {
  view.innerHTML = "";
  const search = h("input", { type: "search", id: "user-search", placeholder: "Search email…" });
  const body = h("div", {});
  view.append(h("div", { class: "card" },
    h("div", { class: "card-head" }, h("h2", {}, "Users"), h("div", { class: "row-gap" }, search)), body));
  const load = async () => {
    body.innerHTML = '<div class="loading">Loading…</div>';
    const { users } = await api("/v1/admin/users" + (search.value ? "?search=" + encodeURIComponent(search.value) : ""));
    body.innerHTML = "";
    body.append(table([
      { label: "Email" }, { label: "Verified" }, { label: "Payouts" }, { label: "Stripe" },
      { label: "Devices", num: true }, { label: "Balance", num: true }, { label: "Earned", num: true },
      { label: "Referral" }, { label: "Joined" }, { label: "" },
    ], users, (u) => [
      td(h("span", { class: "mono" }, u.email || "—")),
      u.emailVerified ? "✓" : "—", u.payoutsEnabled ? "✓" : "—", u.stripeLinked ? "✓" : "—",
      num(u.devices), usd(u.balanceUsd), usd(u.earnedUsd),
      td(h("span", { class: "mono muted" }, u.referralCode || "—")),
      dShort(u.createdAt),
      td(h("button", { class: "btn btn-sm", onclick: () => adjustBalance(u) }, "Adjust")),
    ]));
  };
  let deb; search.addEventListener("input", () => { clearTimeout(deb); deb = setTimeout(load, 300); });
  await load();
}
async function adjustBalance(u) {
  const amount = prompt(`Adjust balance for ${u.email || u.id}.\nEnter dollar amount (positive = credit, negative = debit):`);
  if (amount == null) return;
  const dollars = parseFloat(amount);
  if (!dollars) return toast("Enter a non-zero amount", true);
  const note = prompt("Note (optional, stored on the ledger entry):") || "";
  try {
    await api("/v1/admin/ledger/adjust", { method: "POST", body: {
      userId: u.id, amountCents: Math.round(Math.abs(dollars) * 100), direction: dollars < 0 ? "debit" : "credit", note,
    } });
    toast("Balance adjusted"); route(true);
  } catch (e) { toast(e.message, true); }
}

async function renderEmails(view) {
  const { emails } = await api("/v1/admin/emails");
  const uniq = new Set(emails.map((e) => e.email)).size;
  view.innerHTML = "";
  view.append(h("div", { class: "card" },
    h("div", { class: "card-head" },
      h("h2", {}, `Email list — ${num(emails.length)} rows, ${num(uniq)} unique`),
      h("button", { class: "btn btn-sm btn-accent", onclick: downloadEmailsCsv }, "⤓ Download CSV")),
    h("p", { class: "hint" }, "Collected from users, advertisers, and gift-card recipients."),
    table([{ label: "Email" }, { label: "Source" }, { label: "First seen" }], emails,
      (e) => [h("span", { class: "mono" }, e.email), badge(e.source), dt(e.created_at)])));
}
async function downloadEmailsCsv() {
  try {
    const res = await fetch(API_BASE + "/v1/admin/emails?format=csv", { headers: { "x-admin-key": getKey() } });
    if (!res.ok) throw new Error("export failed");
    const url = URL.createObjectURL(await res.blob());
    const a = h("a", { href: url, download: "freeai-emails.csv" }); document.body.append(a); a.click(); a.remove();
    URL.revokeObjectURL(url); toast("CSV downloaded");
  } catch (e) { toast(e.message, true); }
}

async function renderPayouts(view) {
  const d = await api("/v1/admin/payouts");
  view.innerHTML = "";
  view.append(tiles([
    { k: "Payable now", v: num(d.payable.count), s: "users over threshold", accent: true },
    { k: "Payable total", v: usd(d.payable.totalUsd) },
    { k: "Threshold", v: usd(d.payable.thresholdUsd) },
  ]));
  view.append(h("div", { class: "card" },
    h("div", { class: "card-head" }, h("h2", {}, "Run payouts"),
      h("button", { class: "btn btn-accent", onclick: async () => {
        if (!confirm(`Pay out ${d.payable.count} user(s), ${usd(d.payable.totalUsd)} via Stripe?`)) return;
        try { const r = await api("/v1/admin/payouts", { method: "POST" }); toast(`Paid ${r.paid} payout(s)`); route(true); }
        catch (e) { toast(e.message, true); }
      } }, "Run payout sweep")),
    h("p", { class: "hint" }, "Transfers each eligible developer’s balance to their connected Stripe account.")));
  view.append(h("div", { class: "card" },
    h("div", { class: "card-head" }, h("h2", {}, "Payout history")),
    table([{ label: "Date" }, { label: "User" }, { label: "Amount", num: true }, { label: "Status" }, { label: "Transfer" }],
      d.payouts, (p) => [dt(p.createdAt), h("span", { class: "mono" }, p.email || short(p.userId)), usd(p.amountUsd), td(badge(p.status)), h("span", { class: "mono muted" }, p.transferId || "—")])));
}

async function renderReferrals(view) {
  const d = await api("/v1/admin/referrals");
  view.innerHTML = "";
  view.append(h("div", { class: "card" },
    h("div", { class: "card-head" }, h("h2", {}, "Referrals by status")),
    table([{ label: "Status" }, { label: "Count", num: true }, { label: "Reward paid", num: true }], d.byStatus,
      (s) => [badge(s.status), num(s.count), usd(s.rewardUsd)])));
  view.append(h("div", { class: "card" },
    h("div", { class: "card-head" }, h("h2", {}, "Top referrers")),
    table([{ label: "Referrer" }, { label: "Referred", num: true }, { label: "Rewarded", num: true }, { label: "Earned", num: true }],
      d.top, (t) => [h("span", { class: "mono" }, t.email || short(t.userId)), num(t.referred), num(t.rewarded), usd(t.rewardUsd)])));
  // Referral invites funnel (emails people invited, and how far each got).
  const inv = await tryApi("/v1/admin/invites");
  if (!inv) { view.append(soonCard("Invites sent")); return; }
  view.append(h("div", { class: "card" },
    h("div", { class: "card-head" }, h("h2", {}, "Invites sent"),
      h("p", { class: "hint" }, "Emails referrers invited → joined → rewarded.")),
    table([{ label: "Invited email" }, { label: "Status" }, { label: "Invited by" }, { label: "Sent" }, { label: "Joined" }, { label: "Rewarded" }],
      inv.invites, (i) => [
        h("span", { class: "mono" }, i.email),
        td(badge(i.status)),
        h("span", { class: "mono muted" }, i.referrerEmail || "—"),
        dShort(i.sentAt || i.createdAt), dShort(i.joinedAt), dShort(i.rewardedAt),
      ])));
}

async function renderAffiliates(view) {
  const d = await tryApi("/v1/admin/affiliates");
  view.innerHTML = "";
  if (!d) { view.append(soonCard("Affiliates")); return; }
  const pending = d.affiliates.filter((a) => a.status === "pending").length;
  navDot("affiliates", pending || null);
  view.append(h("div", { class: "card" },
    h("div", { class: "card-head" }, h("h2", {}, "Affiliates"),
      h("p", { class: "hint" }, "Everyone’s auto-enrolled at 10% (self-serve). An “upgrade?” badge means a creator submitted socials wanting more — use Grant upgrade to set a custom rate, raise/remove the cap, and (optionally) give them a vanity code. Reject bans an affiliate.")),
    table([
      { label: "Applicant" }, { label: "Status" }, { label: "Code" }, { label: "Tier" }, { label: "Socials" },
      { label: "Referred", num: true }, { label: "Credited", num: true }, { label: "Joined" }, { label: "" },
    ], d.affiliates, (a) => [
      td(h("span", { class: "mono" }, a.email || "—")),
      td(badge(a.status)),
      td(h("span", { class: "mono" }, a.code || "—")),
      td(affiliateTier(a)),
      td(affiliateSocials(a), "wrap"),
      num(a.attributed_count),
      usd((a.credited_millicents || 0) / 100000),
      dShort(a.created_at),
      td(affiliateActions(a, () => route(true))),
    ])));
}
// Current rate + people cap, with a cue for who's base-tier-with-socials (an
// upgrade request) vs already upgraded. A cap at/above 100k reads as uncapped.
function affiliateTier(a) {
  const bps = a.reward_bps ?? 1000;
  const capPeople = Number(a.cap_people ?? 1000);
  const capLabel = capPeople >= 100000 ? "uncapped" : `${capPeople.toLocaleString()} friends`;
  const base = bps === 1000 && capPeople === 1000;
  const hasSocials = a.instagram_handle || a.linkedin_handle || a.twitter_handle;
  const label = h("span", {}, `${bps / 100}% · ${capLabel}`);
  if (!base) return h("div", { class: "actions" }, label, h("span", { class: "badge approved" }, "upgraded"));
  if (hasSocials) return h("div", { class: "actions" }, label, h("span", { class: "badge pending" }, "upgrade?"));
  return label;
}
function affiliateSocials(a) {
  const wrap = h("div", { class: "actions" });
  const add = (label, handle, followers) => {
    if (!handle) return;
    wrap.append(h("span", { class: "muted" }, `${label}: ${handle} (${num(followers)})`));
  };
  add("IG", a.instagram_handle, a.instagram_followers);
  add("LI", a.linkedin_handle, a.linkedin_followers);
  add("X", a.twitter_handle, a.twitter_followers);
  return wrap.children.length ? wrap : h("span", { class: "muted" }, "—");
}
function affiliateActions(a, reload) {
  const wrap = h("div", { class: "actions" });
  wrap.append(h("button", { class: "btn btn-sm btn-accent", onclick: () => grantUpgrade(a, reload) }, "Grant upgrade"));
  if (a.status === "rejected") wrap.append(h("button", { class: "btn btn-sm", onclick: async () => {
    try { const r = await api("/v1/admin/affiliates/approve", { method: "POST", body: { affiliateId: a.id } }); toast("Reinstated — code " + r.code); reload(); }
    catch (e) { toast(e.message, true); }
  } }, "Reinstate"));
  else wrap.append(h("button", { class: "btn btn-sm btn-danger", onclick: async () => {
    const note = prompt("Reject reason (optional):");
    if (note === null) return;
    try { await api("/v1/admin/affiliates/reject", { method: "POST", body: { affiliateId: a.id, note } }); toast("Rejected"); reload(); }
    catch (e) { toast(e.message, true); }
  } }, "Reject"));
  return wrap;
}
// Grant an influencer upgrade: a custom rate, a raised/uncapped people cap, and
// an optional vanity code. Three quick prompts keep it consistent with the rest
// of this minimal admin (blank cap = uncapped; blank code keeps the current one).
async function grantUpgrade(a, reload) {
  const curPct = (a.reward_bps ?? 1000) / 100;
  const pctStr = prompt(`Reward % for ${a.email || "this affiliate"} (0.01–100):`, String(curPct));
  if (pctStr === null) return;
  const pct = parseFloat(pctStr);
  if (!(pct >= 0.01 && pct <= 100)) { toast("Rate must be between 0.01% and 100%", true); return; }
  const capStr = prompt("Max friends (people cap) — blank or 0 = uncapped:", "");
  if (capStr === null) return;
  const trimmed = capStr.trim();
  const capNum = parseInt(trimmed, 10);
  const uncapped = !trimmed || capNum === 0;
  if (!uncapped && !(capNum > 0)) { toast("Cap must be a positive whole number, or blank for uncapped", true); return; }
  const capPeople = uncapped ? 1000000000 : capNum;
  const code = (prompt("Custom vanity code — 3–16 A–Z/0–9, blank keeps current:", a.code || "") || "").trim();
  try {
    const r = await api("/v1/admin/affiliates/grant", { method: "POST", body: {
      affiliateId: a.id,
      rewardBps: Math.round(pct * 100),
      capPeople,
      code: code && code !== (a.code || "") ? code : undefined,
    } });
    toast(`Upgraded — ${r.affiliate.reward_bps / 100}% · code ${r.affiliate.code}`);
    reload();
  } catch (e) { toast(e.message, true); }
}

async function renderWaitlist(view) {
  const d = await tryApi("/v1/admin/waitlist");
  view.innerHTML = "";
  if (!d) { view.append(soonCard("Waitlist")); return; }
  view.append(tiles(d.bySurface.map((s) => ({ k: s.label || s.surface, v: num(s.count), s: "waiting" }))));
  view.append(h("div", { class: "card" },
    h("div", { class: "card-head" }, h("h2", {}, "Recent signups"),
      h("p", { class: "hint" }, "People who asked to be notified when a surface ships.")),
    table([{ label: "Email" }, { label: "Surface" }, { label: "When" }], d.signups,
      (s) => [h("span", { class: "mono" }, s.email || "—"), s.surface, dt(s.createdAt)])));
}

// Audience landing pages. Reads the static manifest written by
// tools/gen-landers.mjs (landers/landers.json) so this list always matches what
// was generated — no API or admin key needed, it's a same-origin static file.
async function renderLanders(view) {
  view.innerHTML = "";
  let landers = [];
  try {
    const res = await fetch("/landers/landers.json", { cache: "no-store" });
    if (res.ok) landers = await res.json();
  } catch { /* fall through to the empty state below */ }

  const card = h("div", { class: "card" },
    h("div", { class: "card-head" }, h("h2", {}, "Landing pages"),
      h("p", { class: "hint" }, "Per-audience landers. Edit copy in tools/gen-landers.mjs, then run `make landers`.")));

  if (!landers.length) {
    card.append(h("p", { class: "empty" }, "No landers manifest found (landers/landers.json). Run `make landers`."));
    view.append(card);
    return;
  }

  view.append(tiles([{ k: "Live landers", v: num(landers.length) }]));
  card.append(table(
    [{ label: "Audience" }, { label: "URL" }, { label: "Headline" }, { label: "Demo" }],
    landers,
    (l) => [
      h("span", { class: "mono" }, l.slug),
      td(h("a", { href: l.url, target: "_blank", rel: "noopener" }, l.url)),
      l.headline,
      h("span", { class: "badge tool" }, l.tool),
    ],
  ));
  view.append(card);
}

async function renderDevices(view) {
  const d = await api("/v1/admin/devices");
  view.innerHTML = "";
  view.append(tiles([
    { k: "Devices", v: num(d.totals.total), accent: true },
    { k: "Active 24h", v: num(d.totals.active_1d) },
    { k: "Active 7d", v: num(d.totals.active_7d) },
    { k: "Linked to user", v: num(d.totals.linked) },
  ]));
  view.append(h("div", { class: "card" },
    h("div", { class: "card-head" }, h("h2", {}, "Heavy devices today"),
      h("p", { class: "hint" }, `At/over the daily cap (${num(d.caps.dailyImpressionCap)} impr / ${num(d.caps.dailyClickCap)} clicks).`)),
    table([{ label: "Device" }, { label: "Impressions", num: true }, { label: "Clicks", num: true }], d.heavyDevices,
      (x) => [h("span", { class: "mono" }, short(x.deviceId, 14)), num(x.impressions), num(x.clicks)])));
  view.append(h("div", { class: "card" },
    h("div", { class: "card-head" }, h("h2", {}, "Heavy source IPs today"),
      h("p", { class: "hint" }, "Hashed IPs aggregating many impressions — possible farming.")),
    table([{ label: "IP (hashed)" }, { label: "Devices", num: true }, { label: "Impressions", num: true }], d.heavyIps,
      (x) => [h("span", { class: "mono" }, short(x.ipHash, 14)), num(x.devices), num(x.impressions)])));
}

const TABLE_DESC = {
  users: "Developer / advertiser accounts. Balances are derived from the ledger, never stored.",
  devices: "One row per machine running the extension. Earns anonymously, links to a user later.",
  email_tokens: "Single-use magic-link tokens for email verification.",
  advertisers: "Ad campaign creators (email only).",
  campaigns: "Ads. Lifecycle: pending_payment → pending_review → active → exhausted (or rejected/cancelled).",
  event_batches: "Impression/click batches from extensions, with a hashed IP for fraud caps.",
  ledger: "Append-only money log in millicents. The single source of truth for all balances.",
  payouts: "Stripe transfers to developers.",
  gift_redemptions: "Claude gift-card redemptions; fulfillment (sending the card) is manual.",
  web_sessions: "Website login bearer tokens.",
  processed_webhook_events: "Idempotency guard so Stripe webhooks process exactly once.",
  click_tokens: "Single-use server-side click verification tokens.",
  referrals: "One row per referred user; pays the referrer $20 once on first redemption.",
  affiliates: "Affiliate-program applications. Approval mints a code; approved affiliates earn 10% of referred users’ ad revenue as credits.",
  affiliate_attributions: "One row per user attributed to an affiliate (mutually exclusive with a referrer).",
  settings: "Persistent key/value config (e.g. the ad-serving killswitch).",
  diag_errors: "Captured unhandled route errors for diagnostics.",
};
async function renderSchema(view) {
  const { tables } = await api("/v1/admin/schema");
  view.innerHTML = "";
  view.append(h("p", { class: "hint", style: "margin:0 0 16px" }, `${tables.length} tables in the public schema, with live row counts.`));
  const grid = h("div", { class: "schema-grid" });
  for (const t of tables) {
    grid.append(h("div", { class: "schema-card" },
      h("h3", {}, h("span", {}, t.table), h("span", { class: "rc" }, t.rowCount == null ? "—" : num(t.rowCount) + " rows")),
      h("div", { class: "desc" }, TABLE_DESC[t.table] || ""),
      h("ul", { class: "schema-cols" }, t.columns.map((c) =>
        h("li", {}, h("span", { class: "cn" }, c.name), h("span", { class: "ct" }, c.type + (c.nullable ? "" : " · not null")))))));
  }
  view.append(grid);
}

function setServePill(on) {
  const p = $("#serve-pill");
  p.textContent = on ? "● Serving ads" : "● Ads paused";
  p.className = "serve-pill " + (on ? "on" : "off");
}
async function renderSettings(view) {
  const d = await api("/v1/admin/overview");
  setServePill(d.serving);
  view.innerHTML = "";
  view.append(h("div", { class: "card" },
    h("div", { class: "card-head" }, h("h2", {}, "Ad serving killswitch"),
      h("button", { class: "btn " + (d.serving ? "btn-danger" : "btn-accent"), onclick: async () => {
        const next = !d.serving;
        if (!confirm(next ? "Resume serving ads to all users?" : "Pause ALL ad serving immediately?")) return;
        try { await api("/v1/admin/killswitch", { method: "POST", body: { serving: next } }); toast(next ? "Serving resumed" : "Ads paused"); route(true); }
        catch (e) { toast(e.message, true); }
      } }, d.serving ? "Pause ad serving" : "Resume ad serving")),
    h("p", { class: "hint" }, d.serving ? "Ads are live. Pausing stops /v1/ads from returning anything (propagates within ~15s)." : "Ad serving is paused. No ads are being delivered.")));
  await pricingCard(view);
  const cfg = await tryApi("/v1/admin/config");
  if (cfg) view.append(h("div", { class: "card" },
    h("div", { class: "card-head" }, h("h2", {}, "Economics"),
      h("p", { class: "hint" }, "Read-only — set via the function’s environment.")),
    table([{ label: "Setting" }, { label: "Value", num: true }], [
      { k: "Revenue share to developers", v: cfg.revenueSharePct + "%" },
      { k: "Reference gross CPM", v: usd0(cfg.grossCpmUsd) },
      { k: "Daily impression cap / device", v: num(cfg.dailyImpressionCap) },
      { k: "Daily impression cap / IP", v: num(cfg.ipDailyImpressionCap) },
      { k: "Daily click cap / device", v: num(cfg.dailyClickCap) },
      { k: "Payout threshold", v: usd(cfg.payoutThresholdUsd) },
      { k: "Referral reward", v: usd(cfg.referralRewardUsd) },
      { k: "Referral cap / user", v: num(cfg.referralCap) },
      { k: "Affiliate reward share", v: (cfg.affiliateRewardPct ?? 10) + "%" },
      { k: "Affiliate cap / affiliate", v: num(cfg.affiliateCapPeople ?? 1000) + " friends" },
      { k: "Gift fulfillment inbox", v: cfg.giftFulfillmentEmail },
    ], (r) => [r.k, r.v]),
    h("p", { class: "hint", style: "margin-top:14px" }, "Claude gift catalog"),
    table([{ label: "Plan" }, { label: "Monthly", num: true }], cfg.giftPlans, (p) => [p.name, usd(p.monthlyUsd)])));
  view.append(h("div", { class: "card" },
    h("div", { class: "card-head" }, h("h2", {}, "Manual balance adjustment")),
    h("p", { class: "hint" }, "Credit or debit a user’s balance directly. Find the user under the Users tab and use “Adjust”, or use a device/user ID below."),
    adjustForm()));
  const errs = await tryApi("/v1/admin/errors");
  if (errs) view.append(h("div", { class: "card" },
    h("div", { class: "card-head" }, h("h2", {}, "Recent runtime errors"),
      h("p", { class: "hint" }, errs.errors.length ? "Server errors captured by the API dispatch handler." : "No errors logged 🎉")),
    errs.errors.length
      ? table([{ label: "When" }, { label: "Method" }, { label: "Path" }, { label: "Message" }], errs.errors,
          (e) => [dt(e.createdAt), e.method, td(h("span", { class: "mono" }, e.path)), td(h("span", {}, e.message), "wrap")])
      : null));
  view.append(h("div", { class: "card danger-zone" },
    h("div", { class: "card-head" }, h("h2", {}, "Session")),
    h("p", { class: "hint" }, "API: " + API_BASE),
    h("button", { class: "btn btn-ghost", onclick: () => { clearKey(); showGate(); } }, "Log out")));
}
function adjustForm() {
  const uid = h("input", { type: "text", placeholder: "user ID (uuid)" });
  const did = h("input", { type: "text", placeholder: "or device ID (uuid)" });
  const amt = h("input", { type: "number", step: "0.01", placeholder: "amount $" });
  const dir = h("select", {}, h("option", { value: "credit" }, "credit (+)"), h("option", { value: "debit" }, "debit (−)"));
  const note = h("input", { type: "text", placeholder: "note (optional)" });
  return h("div", { class: "inline-form", style: "margin-top:6px" },
    h("label", { class: "fld" }, "User ID", uid),
    h("label", { class: "fld" }, "Device ID", did),
    h("label", { class: "fld" }, "Amount", amt),
    h("label", { class: "fld" }, "Direction", dir),
    h("label", { class: "fld" }, "Note", note),
    h("button", { class: "btn btn-accent", onclick: async () => {
      const cents = Math.round(Math.abs(parseFloat(amt.value) || 0) * 100);
      if (!cents) return toast("Enter an amount", true);
      if (!uid.value.trim() && !did.value.trim()) return toast("Need a user or device ID", true);
      try {
        await api("/v1/admin/ledger/adjust", { method: "POST", body: {
          userId: uid.value.trim() || null, deviceId: did.value.trim() || null, amountCents: cents, direction: dir.value, note: note.value.trim(),
        } });
        toast("Adjustment posted"); uid.value = did.value = amt.value = note.value = "";
      } catch (e) { toast(e.message, true); }
    } }, "Post"));
}

// Advertiser pricing knobs — minimum (enforced floor), suggested (pre-fills the
// form), and a top-bid anchor. The lander reads these from /v1/config.
async function pricingCard(view) {
  const p = await tryApi("/v1/admin/pricing");
  if (!p) return; // endpoint not deployed yet — degrade gracefully
  const dollar = (c) => (Number(c || 0) / 100).toFixed(2);
  // CPM == price per 1,000 impressions. Fall back to old *Bid* keys for one deploy.
  const minCpmI = h("input", { type: "number", step: "1", min: "0.50", value: dollar(p.minCpmCents ?? p.minBidCents) });
  const sugCpmI = h("input", { type: "number", step: "1", min: "0.50", value: dollar(p.suggestedCpmCents ?? p.suggestedBidCents) });
  const maxCpmI = h("input", { type: "number", step: "1", min: "0.50", value: dollar(p.maxCpmCents ?? 10000) });
  const topI = h("input", { type: "number", step: "1", min: "0", value: dollar(p.topCpmAnchorCents ?? p.topBidAnchorCents) });
  const minBudI = h("input", { type: "number", step: "1", min: "1", value: dollar(p.minBudgetCents ?? 10000) });
  const sugBudI = h("input", { type: "number", step: "1", min: "1", value: dollar(p.suggestedBudgetCents ?? 250000) });
  const maxBudI = h("input", { type: "number", step: "1", min: "1", value: dollar(p.maxBudgetCents ?? 10000000) });
  view.append(h("div", { class: "card" },
    h("div", { class: "card-head" }, h("h2", {}, "Advertiser pricing"),
      h("p", { class: "hint" }, `Shown on the advertiser page. Advertisers set a budget and a CPM (cost per 1,000 impressions). Displayed “top CPM” = the higher of your anchor and the current highest active bid (${usd((p.topActiveBidCents || 0) / 100)}), capped at Max CPM.`)),
    h("div", { class: "inline-form", style: "margin-top:6px" },
      h("label", { class: "fld" }, "Min CPM $", minCpmI),
      h("label", { class: "fld" }, "Suggested CPM $", sugCpmI),
      h("label", { class: "fld" }, "Max CPM $", maxCpmI),
      h("label", { class: "fld" }, "Top-CPM anchor $", topI),
      h("label", { class: "fld" }, "Min budget $", minBudI),
      h("label", { class: "fld" }, "Suggested budget $", sugBudI),
      h("label", { class: "fld" }, "Max budget $", maxBudI),
      h("button", { class: "btn btn-accent", onclick: async () => {
        const cents = (el) => Math.round((parseFloat(el.value) || 0) * 100);
        try {
          await api("/v1/admin/pricing", { method: "POST", body: {
            minCpmCents: cents(minCpmI), suggestedCpmCents: cents(sugCpmI), maxCpmCents: cents(maxCpmI),
            topCpmAnchorCents: cents(topI), minBudgetCents: cents(minBudI),
            suggestedBudgetCents: cents(sugBudI), maxBudgetCents: cents(maxBudI),
          } });
          toast("Pricing saved"); route(true);
        } catch (e) { toast(e.message, true); }
      } }, "Save pricing"))));
}

// ── boot ─────────────────────────────────────────────────────────────────────
buildNav();
if (getKey()) {
  const k = getKey();
  api("/v1/admin/overview").then(() => { showApp(); route(); }).catch(() => { if (getKey() === k) showGate(); });
} else showGate();
