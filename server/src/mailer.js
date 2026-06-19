// Pluggable mailer. Default transport logs to the console so verification works
// end-to-end in dev/CI with no provider. In production, set MAIL_PROVIDER=resend
// and RESEND_API_KEY (or wire your own transport) — no other code changes.

function createMailer(config) {
  const provider = config.mailProvider || "console";

  async function send(to, subject, htmlBody) {
    if (provider === "resend" && config.resendApiKey) {
      const res = await (config.fetchImpl || fetch)("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.resendApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: config.mailFrom || "FreeAI <hello@freeai.fyi>",
          to,
          subject,
          html: htmlBody,
        }),
      });
      if (!res.ok) throw new Error("resend send failed: " + res.status);
      return;
    }
    // console transport
    console.log(`[freeai][mail] to=${to} subject="${subject}"`);
  }

  async function sendVerifyEmail(to, link) {
    await send(
      to,
      "Verify your email to get paid",
      `<p>Confirm this address to start receiving FreeAI payouts.</p>
       <p><a href="${link}">Verify my email</a></p>
       <p>This link expires in 30 minutes. If you didn't request it, ignore this email.</p>`
    );
  }

  // Magic-link login for the website, where users redeem credits for Claude
  // gift cards. Clicking the link opens a logged-in redemption session.
  async function sendWebLoginEmail(to, link) {
    await send(
      to,
      "Your FreeAI sign-in link",
      `<p>Click to sign in and redeem your FreeAI credits for Claude.</p>
       <p><a href="${link}">Sign in to FreeAI</a></p>
       <p>This link expires in 30 minutes. If you didn't request it, ignore this email.</p>`
    );
  }

  // Receipt for an advertiser whose Stripe Checkout payment just completed.
  // Confirms the charge and sets the expectation that the ad doesn't serve
  // until it clears review. Stripe sends its own itemized payment receipt
  // separately (via receipt_email on the checkout session).
  async function sendAdvertiserReceiptEmail(to, { campaignId, brand, adLine, pricePerBlockCents, blocks }) {
    const perBlockUsd = pricePerBlockCents / 100;
    const totalUsd = (pricePerBlockCents * blocks) / 100;
    const impressions = blocks * 1000;
    await send(
      to,
      "Your FreeAI campaign receipt",
      `<p>Thanks for advertising on FreeAI — your payment is confirmed.</p>
       <ul>
         <li><strong>Ad line:</strong> "${adLine}"</li>
         ${brand ? `<li><strong>Brand:</strong> ${brand}</li>` : ""}
         <li><strong>Blocks:</strong> ${blocks} (${impressions.toLocaleString("en-US")} impressions)</li>
         <li><strong>Price per block:</strong> US$${perBlockUsd.toFixed(2)}</li>
         <li><strong>Total paid:</strong> US$${totalUsd.toFixed(2)}</li>
         <li><strong>Campaign id:</strong> ${campaignId}</li>
       </ul>
       <p>Your campaign is now in review and goes live once we approve it — usually within a day.</p>
       <p>Stripe has emailed a separate itemized payment receipt for your records.</p>`
    );
  }

  // Sent when a paid campaign is rejected in moderation and refunded. Tells the
  // advertiser the charge was reversed (Stripe also emails its own refund
  // notification) and includes the reviewer's note when there is one.
  async function sendCampaignRejectedEmail(to, { campaignId, brand, adLine, pricePerBlockCents, blocks, note }) {
    const totalUsd = (pricePerBlockCents * blocks) / 100;
    await send(
      to,
      "Your FreeAI campaign was refunded",
      `<p>Thanks for your interest in advertising on FreeAI. We weren't able to approve this campaign, so we've refunded it in full.</p>
       <ul>
         <li><strong>Ad line:</strong> "${adLine}"</li>
         ${brand ? `<li><strong>Brand:</strong> ${brand}</li>` : ""}
         <li><strong>Refunded:</strong> US$${totalUsd.toFixed(2)}</li>
         <li><strong>Campaign id:</strong> ${campaignId}</li>
       </ul>
       ${note ? `<p><strong>Reviewer note:</strong> ${note}</p>` : ""}
       <p>The refund returns to your original payment method; Stripe will email a separate confirmation. You're welcome to submit a new campaign any time.</p>`
    );
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
    const reward = `$${Math.round(rewardUsd)}`;
    await send(
      to,
      `${inviterEmail} invited you to FreeAI — free Claude credits`,
      `<p>${inviterEmail} is using FreeAI to earn free Claude credits and wants you in.</p>
       <p>FreeAI shows one subtle sponsored line while you use ChatGPT, Claude, or
          Gemini, and pays you back 50% of the revenue as Claude credits.</p>
       <p><a href="${link}">Accept the invite and claim your credits</a></p>
       <p>When you sign up with this link and redeem your first Claude gift card,
          ${inviterEmail} earns a one-time ${reward} bonus — at no cost to you.</p>`
    );
  }

  return { sendVerifyEmail, sendWebLoginEmail, sendAdvertiserReceiptEmail, sendCampaignRejectedEmail, sendGiftRedemptionEmail, sendReferralInviteEmail };
}

module.exports = { createMailer };
