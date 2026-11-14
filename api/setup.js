import { getSheetsStore } from "../lib/sheets.js";
import { safeEqual } from "../lib/security.js";

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
    const status = await getSheetsStore().status();
    res.statusCode = 200;
    res.end(JSON.stringify(status));
  } catch (error) {
    console.error("setup_failed", { error: String(error?.message || error).slice(0, 500) });
    res.statusCode = 500;
    res.end(JSON.stringify({ ok: false, error: "setup_failed" }));
  }
}
