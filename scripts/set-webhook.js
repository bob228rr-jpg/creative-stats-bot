const required = ["BOT_TOKEN", "TELEGRAM_SECRET", "WEBHOOK_URL"];
const missing = required.filter((name) => !process.env[name]?.trim());
if (missing.length) {
  console.error(`Missing environment variables: ${missing.join(", ")}`);
  process.exit(1);
}

const base = (process.env.TELEGRAM_API_BASE || "https://api.telegram.org").replace(/\/$/, "");
const response = await fetch(`${base}/bot${process.env.BOT_TOKEN}/setWebhook`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    url: process.env.WEBHOOK_URL,
    secret_token: process.env.TELEGRAM_SECRET,
    allowed_updates: ["message", "callback_query"],
    drop_pending_updates: false,
  }),
});
const payload = await response.json();
if (!response.ok || !payload.ok) {
  console.error("setWebhook failed", { status: response.status, description: payload.description });
  process.exit(1);
}
console.log("Webhook configured successfully.");
