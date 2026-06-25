// Pluggable mailer. Default transport logs to the console so verification works
// end-to-end in dev/CI with no provider. In production, set MAIL_PROVIDER=resend
// and RESEND_API_KEY (or wire your own transport) — no other code changes.

const { escapeHtml } = require("./util");

function createMailer(config) {
  const provider = config.mailProvider || "console";
  // Per-audience senders, all on the Resend-verified contact.freeai.fyi domain.
  // User mail comes from hello@ with replies routed to support@; advertiser mail
  // comes from ads@. Overridable via MAIL_FROM / MAIL_FROM_ADS.
  const userFrom = config.mailFrom || "FreeAI <hello@contact.freeai.fyi>";
  const adsFrom = config.mailFromAds || "FreeAI <ads@contact.freeai.fyi>";
  const supportReplyTo = "support@contact.freeai.fyi";
  const adsReplyTo = "ads@contact.freeai.fyi";

  async function send(to, subject, htmlBody, opts = {}) {
    const from = opts.from || userFrom;
    const replyTo = opts.replyTo !== undefined ? opts.replyTo : supportReplyTo;
    if (provider === "resend" && config.resendApiKey) {
      const payload = { from, to, subject, html: htmlBody };
      if (replyTo) payload.reply_to = replyTo;
      const res = await (config.fetchImpl || fetch)("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.resendApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error("resend send failed: " + res.status);
      return;
    }
    // console transport (dev/CI). Print the action link too, so magic-link /
    // verify flows can be completed end-to-end locally (e.g. `make devnet`)
    // without a real mail provider. Never used in production (set
    // MAIL_PROVIDER=resend there).
    const link = (String(htmlBody).match(/href="([^"]+)"/) || [])[1];
    console.log(`[freeai][mail] to=${to} subject="${subject}" from=${from}${link ? ` link=${link}` : ""}`);
  }
  const sendAds = (to, subject, htmlBody) => send(to, subject, htmlBody, { from: adsFrom, replyTo: adsReplyTo });

  // ── Branded shell for user-facing emails (sign-in, verify, invites,
  // redemption, reward). Table layout + inline styles so it renders across mail
  // clients; palette mirrors theme.css (Claude coral on cream). The advertiser
  // and admin notices below keep their original plain layout on purpose. ──
  const FONT = "'Inter',system-ui,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
  const site = config.siteUrl || "https://freeai.fyi";
  function button(href, label) {
    return `<table role="presentation" cellpadding="0" cellspacing="0" align="center" style="margin:26px auto 6px;"><tr>`
      + `<td align="center" bgcolor="#d97757" style="border-radius:10px;background:#d97757;background:linear-gradient(180deg,#e08a6a,#cf6b4a);">`
      + `<a href="${href}" style="display:inline-block;padding:13px 28px;font-family:${FONT};font-size:15px;font-weight:700;color:#ffffff;text-decoration:none;border-radius:10px;">${label}</a>`
      + `</td></tr></table>`;
  }
  function shell({ preheader = "", hero = "", heading = "", body = "", cta = null, note = "" }) {
    const btn = cta ? button(cta.href, cta.label) : "";
    const foot = note ? `<p style="margin:18px 0 0;font-family:${FONT};font-size:13px;line-height:1.55;color:#9b988f;">${note}</p>` : "";
    return `<!doctype html><html lang="en"><head><meta charset="utf-8">`
      + `<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light only"></head>`
      + `<body style="margin:0;padding:0;background:#faf9f5;">`
      + `<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:#faf9f5;font-size:1px;line-height:1px;">${preheader}</div>`
      + `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#faf9f5;"><tr><td align="center" style="padding:30px 16px;">`
      + `<table role="presentation" width="480" cellpadding="0" cellspacing="0" style="width:480px;max-width:100%;">`
      + `<tr><td align="center" style="padding:2px 0 22px;"><table role="presentation" cellpadding="0" cellspacing="0"><tr>`
      + `<td width="44" height="44" align="center" valign="middle" bgcolor="#d97757" style="width:44px;height:44px;border-radius:11px;background:#d97757;background:linear-gradient(180deg,#e08a6a,#cf6b4a);font-family:'JetBrains Mono',ui-monospace,Menlo,monospace;font-size:20px;font-weight:800;color:#ffffff;">F$</td>`
      + `</tr></table></td></tr>`
      + `<tr><td style="background:#ffffff;border:1px solid #e6e2d8;border-radius:16px;padding:34px 32px;">`
      + (hero ? `<div style="text-align:center;font-size:40px;line-height:1;margin:0 0 12px;">${hero}</div>` : "")
      + (heading ? `<h1 style="margin:0 0 16px;text-align:center;font-family:${FONT};font-size:21px;font-weight:800;letter-spacing:-0.02em;color:#1f1e1d;">${heading}</h1>` : "")
      + `<div style="font-family:${FONT};font-size:15px;line-height:1.6;color:#3d3b37;">${body}</div>${btn}${foot}`
      + `</td></tr>`
      + `<tr><td align="center" style="padding:22px 10px 6px;font-family:${FONT};font-size:12px;line-height:1.7;color:#9b988f;">`
      + `<a href="${site}" style="color:#c15f3c;text-decoration:none;font-weight:700;">freeai.fyi</a>`
      + `&nbsp;·&nbsp;<a href="${site}/terms" style="color:#9b988f;text-decoration:underline;">Terms</a>`
      + `&nbsp;·&nbsp;<a href="${site}/privacy" style="color:#9b988f;text-decoration:underline;">Privacy</a>`
      + `<br>Earn credits while you use Claude, ChatGPT &amp; Gemini.`
      + `</td></tr></table></td></tr></table></body></html>`;
  }

  // Key/value detail box for the campaign emails — same inset style as the
  // user-email tables, with hairline row separators. Falsy rows are dropped.
  function detail(rows) {
    const cells = rows.filter(Boolean).map(([k, v], i) =>
      `<tr><td style="padding:8px 16px;font-family:${FONT};font-size:13px;color:#6b6963;${i ? "border-top:1px solid #efeae0;" : ""}">${k}</td>`
      + `<td style="padding:8px 16px;font-family:${FONT};font-size:13px;font-weight:600;color:#1f1e1d;text-align:right;${i ? "border-top:1px solid #efeae0;" : ""}">${v}</td></tr>`).join("");
    return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:6px 0 2px;background:#faf9f5;border:1px solid #e6e2d8;border-radius:12px;">${cells}</table>`;
  }

  async function sendVerifyEmail(to, link) {
    await send(to, "Verify your email to get paid", shell({
      preheader: "Confirm your email to start receiving FreeAI payouts.",
      hero: "✅", heading: "Verify your email to get paid",
      body: `<p style="margin:0 0 14px;">Confirm this address so your FreeAI credits land in the right place.</p>`,
      cta: { href: link, label: "Verify my email" },
      note: "This link expires in 30 minutes. If you didn't request it, you can safely ignore this email.",
    }));
  }

  // Magic-link login for the website, where users redeem credits for Claude
  // gift cards. Clicking the link opens a logged-in redemption session.
  async function sendWebLoginEmail(to, link) {
    await send(to, "Your FreeAI sign-in link", shell({
      preheader: "Your secure FreeAI sign-in link — expires in 30 minutes.",
      hero: "🔑", heading: "Sign in to FreeAI",
      body: `<p style="margin:0 0 14px;">Tap the button below to sign in and manage your FreeAI credits — redeem them for Claude, ChatGPT or Gemini gift cards whenever you like.</p>`,
      cta: { href: link, label: "Sign in to FreeAI" },
      note: "This link expires in 30 minutes and can only be used once. If you didn't request it, ignore this email.",
    }));
  }

  // Receipt for an advertiser whose Stripe Checkout payment just completed.
  // Confirms the charge and sets the expectation that the ad doesn't serve
  // until it clears review. Stripe sends its own itemized payment receipt
  // separately (via receipt_email on the checkout session).
  async function sendAdvertiserReceiptEmail(to, { campaignId, brand, adLine, pricePerBlockCents, blocks }) {
    await sendAds(to, "Your FreeAI campaign receipt", shell({
      preheader: "Your FreeAI campaign payment is confirmed — now in review.",
      hero: "💳", heading: "Payment confirmed",
      body: `<p style="margin:0 0 14px;">Thanks for advertising on FreeAI — your payment is confirmed and your campaign is in review.</p>`
        + detail([
          ["Ad line", `“${adLine}”`],
          brand ? ["Brand", brand] : null,
          ["Volume", `${blocks} block${blocks === 1 ? "" : "s"} · ${(blocks * 1000).toLocaleString("en-US")} impressions`],
          ["Price / block", `US$${(pricePerBlockCents / 100).toFixed(2)}`],
          ["Total paid", `US$${((pricePerBlockCents * blocks) / 100).toFixed(2)}`],
          ["Campaign", campaignId],
        ]),
      note: "It goes live once we approve it — usually within a day. Stripe has emailed a separate itemized receipt for your records.",
    }));
  }

  // Sent when a paid campaign is rejected in moderation and refunded. Tells the
  // advertiser the charge was reversed (Stripe also emails its own refund
  // notification) and includes the reviewer's note when there is one.
  async function sendCampaignRejectedEmail(to, { campaignId, brand, adLine, pricePerBlockCents, blocks, note }) {
    await sendAds(to, "Your FreeAI campaign was refunded", shell({
      preheader: "Your FreeAI campaign wasn't approved — refunded in full.",
      hero: "💸", heading: "Your campaign was refunded",
      body: `<p style="margin:0 0 14px;">Thanks for your interest in advertising on FreeAI. We weren't able to approve this campaign, so we've refunded it in full.</p>`
        + detail([
          ["Ad line", `“${adLine}”`],
          brand ? ["Brand", brand] : null,
          ["Refunded", `US$${((pricePerBlockCents * blocks) / 100).toFixed(2)}`],
          ["Campaign", campaignId],
        ])
        + (note ? `<p style="margin:14px 0 0;font-family:${FONT};font-size:14px;line-height:1.5;color:#3d3b37;"><strong style="color:#1f1e1d;">Reviewer note:</strong> ${note}</p>` : ""),
      note: "The refund returns to your original payment method; Stripe will email a separate confirmation. You're welcome to submit a new campaign any time.",
    }));
  }

  // Pure builder for the "campaign finished" advertiser receipt — returns
  // { subject, html } so the admin can PREVIEW it (render, don't send) and the send
  // path shares the exact same render. Advertiser-controlled fields are escaped
  // (defense-in-depth; the preview renders in the admin's browser).
  function buildCampaignCompletedEmail(s) {
    const money = (n) => "US$" + (Number(n) || 0).toFixed(2);
    const nfmt = (n) => (Number(n) || 0).toLocaleString("en-US");
    const pct = (r) => (r == null ? "—" : (Number(r) * 100).toFixed(2) + "%");
    return {
      subject: "Your FreeAI campaign wrapped up — the final numbers",
      html: shell({
        preheader: "Your FreeAI campaign finished — here are its final results.",
        hero: "📊", heading: "Your campaign wrapped up",
        body: `<p style="margin:0 0 14px;">Your FreeAI campaign has finished — its budget is fully spent. Here's how it performed:</p>`
          + detail([
            ["Ad line", `“${escapeHtml(s.adLine)}”`],
            s.brand ? ["Brand", escapeHtml(s.brand)] : null,
            ["Impressions shown", nfmt(s.impressionsShown)],
            ["Clicks", nfmt(s.clicks)],
            ["Click-through rate", pct(s.ctr)],
            ["Cost per click", s.cpcUsd == null ? "—" : money(s.cpcUsd)],
            ["Effective CPM", s.ecpmUsd == null ? "—" : money(s.ecpmUsd)],
            ["Total spent", money(s.totalPaidUsd)],
            ["Campaign", escapeHtml(s.campaignId)],
          ]),
        note: "Thanks for advertising on FreeAI — just reply to this email to plan your next campaign.",
      }),
    };
  }
  async function sendCampaignCompletedEmail(to, stats) {
    const { subject, html } = buildCampaignCompletedEmail(stats);
    await sendAds(to, subject, html);
  }

  // Fulfillment notification for a Claude gift card redemption. Goes to the
  // fulfillment inbox (not the user); the gift card itself is sent manually
  // within 48 hours.
  async function sendGiftRedemptionEmail(to, { redemptionId, planName, months, amountUsd, recipientEmail }) {
    await send(
      to,
      `Gift card redemption: ${months} month${months > 1 ? "s" : ""} of ${planName}`,
      `<p>A FreeAI user redeemed their credits for a Claude gift card.</p>
       <ul>
         <li><strong>Plan:</strong> ${planName}</li>
         <li><strong>Duration:</strong> ${months} month${months > 1 ? "s" : ""}</li>
         <li><strong>Value:</strong> US$${amountUsd.toFixed(2)}</li>
         <li><strong>Send the gift card to:</strong> ${recipientEmail}</li>
         <li><strong>Redemption id:</strong> ${redemptionId}</li>
       </ul>
       <p>Please fulfill within 48 hours.</p>`
    );
  }

  // Invite a friend to FreeAI. Sent to the invitee from the dashboard's
  // "refer a friend" form. The link carries the referrer's code (?ref=…) so the
  // friend is attributed when they sign up.
  async function sendReferralInviteEmail(to, { inviterEmail, link, rewardUsd }) {
    await send(to, `${inviterEmail} invited you to FreeAI — free Claude credits`, shell({
      preheader: `${inviterEmail} invited you to FreeAI — earn free Claude credits.`,
      hero: "🎁", heading: "You're invited to FreeAI",
      body: `<p style="margin:0 0 14px;"><strong style="color:#1f1e1d;">${inviterEmail}</strong> is earning free Claude credits with FreeAI and wants you in.</p>`
        + `<p style="margin:0 0 14px;">Earn Claude credits as you use ChatGPT, Claude or Gemini — cash out anytime for gift cards.</p>`,
      cta: { href: link, label: "Accept the invite" },
      note: `When you sign up with this link and redeem your first Claude gift card, ${inviterEmail} earns a one-time $${Math.round(rewardUsd)} bonus — at no cost to you.`,
    }));
  }

  // Crew invite from the extension popup: the friend is attributed to the
  // inviter's affiliate code, so the inviter earns their cut of everything the
  // friend makes — forever. The friend keeps 100% of their own earnings.
  async function sendCrewInviteEmail(to, { inviterEmail, link, rewardPct }) {
    await send(to, `${inviterEmail} added you to their FreeAI crew`, shell({
      preheader: `${inviterEmail} added you to their FreeAI crew — earn free Claude credits.`,
      hero: "🤝", heading: "Join your friend's FreeAI crew",
      body: `<p style="margin:0 0 14px;"><strong style="color:#1f1e1d;">${inviterEmail}</strong> is earning free Claude credits with FreeAI and added you to their crew.</p>`
        + `<p style="margin:0 0 14px;">Earn Claude credits as you use ChatGPT, Claude or Gemini.</p>`,
      cta: { href: link, label: "Join the crew" },
      note: `You keep 100% of what you earn. ${inviterEmail} earns an extra ${Math.round(rewardPct)}% on top — at no cost to you.`,
    }));
  }

  // Confirmation to the user who just redeemed credits for a Claude gift card
  // (the fulfillment inbox gets its own separate notice above).
  async function sendRedemptionConfirmationEmail(to, { planName, months, amountUsd }) {
    await send(to, `Your Claude gift card is on the way — ${months} month${months > 1 ? "s" : ""} of ${planName}`, shell({
      preheader: `We got your redemption — ${months} month${months > 1 ? "s" : ""} of ${planName}.`,
      hero: "🧾", heading: "Your redemption is in",
      body: `<p style="margin:0 0 16px;">Nice work — you've cashed in your FreeAI credits for a Claude gift card. Here's what's on the way:</p>`
        + `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#faf9f5;border:1px solid #e6e2d8;border-radius:12px;"><tr>`
        + `<td style="padding:14px 16px;font-family:${FONT};font-size:14px;line-height:1.5;color:#3d3b37;"><strong style="color:#1f1e1d;">${planName}</strong> · ${months} month${months > 1 ? "s" : ""}<br><span style="color:#6b6963;">Value: US$${amountUsd.toFixed(2)} in Claude credits</span></td>`
        + `</tr></table>`,
      note: "We fulfill gift cards within 48 hours — keep an eye on your inbox for the Claude gift card.",
    }));
  }

  // Sent to the referrer when a friend they referred redeems their first gift
  // card, which is what unlocks the one-time referral bonus.
  async function sendReferralRewardEmail(to, { rewardUsd, link }) {
    await send(to, `You earned $${Math.round(rewardUsd)} in Claude credits 🎉`, shell({
      preheader: `You earned $${Math.round(rewardUsd)} in Claude credits from a referral.`,
      hero: "🎉", heading: `You earned $${Math.round(rewardUsd)} in credits!`,
      body: `<p style="margin:0 0 14px;">A friend you referred just redeemed their first Claude gift card on FreeAI — so we've added a one-time <strong style="color:#1f1e1d;">$${Math.round(rewardUsd)}</strong> bonus to your balance. 🙌</p>`
        + `<p style="margin:0 0 14px;">Keep inviting friends to stack up more credits.</p>`,
      cta: { href: link, label: "View your dashboard" },
      note: "Credits never expire — redeem them for Claude, ChatGPT or Gemini gift cards anytime.",
    }));
  }

  // Pre-account waitlist confirmation: someone typed their email under the hero
  // ("Join the waitlist to earn") while a surface is still in review. No account
  // exists yet — a friendly receipt that warms the address up before launch.
  async function sendWaitlistConfirmationEmail(to) {
    await send(to, "You're on the FreeAI waitlist 🎉", shell({
      preheader: "You're on the list — we'll email you the moment FreeAI is live.",
      hero: "🎉", heading: "You're on the waitlist",
      body: `<p style="margin:0 0 14px;">Thanks for joining FreeAI — you're on the list. We'll email you the moment you can install it and start earning Claude credits while you use ChatGPT, Claude &amp; Gemini.</p>`
        + `<p style="margin:0;">The Chrome extension is in review right now, with the command line and desktop apps close behind.</p>`,
      note: "You're getting this because you joined the waitlist at freeai.fyi. Didn't sign up? You can safely ignore this email.",
    }));
  }

  return {
    sendVerifyEmail, sendWebLoginEmail, sendAdvertiserReceiptEmail, sendCampaignRejectedEmail,
    sendCampaignCompletedEmail, buildCampaignCompletedEmail,
    sendGiftRedemptionEmail, sendReferralInviteEmail, sendCrewInviteEmail,
    sendRedemptionConfirmationEmail, sendReferralRewardEmail, sendWaitlistConfirmationEmail,
  };
}

module.exports = { createMailer };
