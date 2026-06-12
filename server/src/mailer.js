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

  return { sendVerifyEmail, sendWebLoginEmail, sendGiftRedemptionEmail };
}

module.exports = { createMailer };
