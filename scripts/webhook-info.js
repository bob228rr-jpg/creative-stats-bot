if (!process.env.BOT_TOKEN?.trim()) {
  console.error("Missing environment variable: BOT_TOKEN");
  process.exit(1);
}
const base = (process.env.TELEGRAM_API_BASE || "https://api.telegram.org").replace(/\/$/, "");
const response = await fetch(`${base}/bot${process.env.BOT_TOKEN}/getWebhookInfo`, { signal: AbortSignal.timeout(10_000) });
const payload = await response.json();
if (!response.ok || !payload.ok) {
  console.error("getWebhookInfo failed", { status: response.status, description: payload.description });
  process.exit(1);
}
const info = payload.result;
console.log({
  url: info.url,
  hasCustomCertificate: info.has_custom_certificate,
  pendingUpdateCount: info.pending_update_count,
  lastErrorDate: info.last_error_date || null,
  lastErrorMessage: info.last_error_message || null,
  allowedUpdates: info.allowed_updates || [],
});
