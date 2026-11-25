import { getBaseConfig } from "../lib/config.js";
import { getSheetsStore } from "../lib/sheets.js";
import { safeEqual } from "../lib/security.js";
import { TelegramClient } from "../lib/telegram.js";

function parseBody(body) {
  if (!body) return {};
  if (typeof body === "string") return JSON.parse(body);
  return body;
}

async function configureWebhook() {
  const config = getBaseConfig();
  const productionHost = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  if (!productionHost) throw new Error("VERCEL_PROJECT_PRODUCTION_URL is missing.");
  const telegram = new TelegramClient(config);
  const url = `https://${productionHost}/api/telegram`;
  await telegram.call("setWebhook", {
    url,
    secret_token: config.telegramSecret,
    allowed_updates: ["message", "callback_query"],
    max_connections: 1,
    drop_pending_updates: false,
  });
  const info = await telegram.call("getWebhookInfo", {});
  return {
    configured: true,
    url: info.url,
    pendingUpdateCount: info.pending_update_count,
    lastErrorDate: info.last_error_date || null,
    lastErrorMessage: info.last_error_message || null,
    allowedUpdates: info.allowed_updates || [],
  };
}

export default async function handler(req, res) {
  res.setHeader("content-type", "application/json; charset=utf-8");
  if (req.method !== "POST") {
    res.statusCode = 405;
    res.setHeader("allow", "POST");
    res.end(JSON.stringify({ ok: false, error: "method_not_allowed" }));
    return;
  }
  const expected = process.env.TELEGRAM_SECRET;
  const actual = req.headers["x-setup-secret"];
  if (!expected || !safeEqual(actual, expected)) {
    res.statusCode = 403;
    res.end(JSON.stringify({ ok: false, error: "forbidden" }));
    return;
  }
  try {
    const body = parseBody(req.body);
    const status = await getSheetsStore().status({ configure: true });
    const webhook = body.configureWebhook ? await configureWebhook() : undefined;
    res.statusCode = 200;
    res.end(JSON.stringify({ ...status, webhook }));
  } catch (error) {
    console.error("setup_failed", { error: String(error?.message || error).slice(0, 500) });
    res.statusCode = 500;
    res.end(JSON.stringify({ ok: false, error: "setup_failed" }));
  }
}
