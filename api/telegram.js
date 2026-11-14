import { processUpdate } from "../lib/bot.js";
import { isPrivateAuthorizedUpdate, safeEqual } from "../lib/security.js";

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader("content-type", "text/plain; charset=utf-8");
  res.end(body);
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("allow", "POST");
    send(res, 405, "Method Not Allowed");
    return;
  }
  const expectedSecret = process.env.TELEGRAM_SECRET;
  const actualSecret = req.headers["x-telegram-bot-api-secret-token"];
  if (!expectedSecret || !safeEqual(actualSecret, expectedSecret)) {
    send(res, 403, "Forbidden");
    return;
  }
  let update;
  try {
    update = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
  } catch {
    send(res, 400, "Bad Request");
    return;
  }
  if (!update || typeof update !== "object") {
    send(res, 400, "Bad Request");
    return;
  }
  if (!isPrivateAuthorizedUpdate(update, process.env.TELEGRAM_USER_ID)) {
    send(res, 200, "OK");
    return;
  }
  try {
    await processUpdate(update);
    send(res, 200, "OK");
  } catch (error) {
    console.error("telegram_update_failed", {
      updateId: update.update_id,
      kind: update.callback_query ? "callback" : "message",
      error: String(error?.message || error).slice(0, 500),
    });
    send(res, 500, "Internal Server Error");
  }
}
