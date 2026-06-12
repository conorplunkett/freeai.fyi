// Pluggable mailer. Default transport logs to the console so verification works
// end-to-end in dev/CI with no provider. In production, set MAIL_PROVIDER=resend
// and RESEND_API_KEY (or wire your own transport) — no other code changes.

function createMailer(config) {
  const provider = config.mailProvider || "console";

  async function sendVerifyEmail(to, link) {
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
          subject: "Verify your email to get paid",
          html: `<p>Confirm this address to start receiving FreeAI payouts.</p>
                 <p><a href="${link}">Verify my email</a></p>
                 <p>This link expires in 30 minutes. If you didn't request it, ignore this email.</p>`,
        }),
      });
      if (!res.ok) throw new Error("resend send failed: " + res.status);
      return;
    }
    // console transport
    console.log(`[freeai][mail] verify ${to} -> ${link}`);
  }

  return { sendVerifyEmail };
}

module.exports = { createMailer };
