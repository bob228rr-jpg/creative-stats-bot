import assert from "node:assert/strict";
import test from "node:test";
import handler from "../api/telegram.js";

function responseRecorder() {
  return {
    statusCode: 0,
    headers: {},
    body: "",
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
    },
    end(value = "") {
      this.body = value;
    },
  };
}

test("webhook rejects non-POST methods with 405", async () => {
  const res = responseRecorder();
  await handler({ method: "GET", headers: {} }, res);
  assert.equal(res.statusCode, 405);
  assert.equal(res.headers.allow, "POST");
});

test("webhook rejects missing secret with internal 403", async () => {
  const previous = process.env.TELEGRAM_SECRET;
  process.env.TELEGRAM_SECRET = "expected-secret";
  const res = responseRecorder();
  await handler({ method: "POST", headers: {}, body: {} }, res);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body, "Forbidden");
  if (previous === undefined) delete process.env.TELEGRAM_SECRET;
  else process.env.TELEGRAM_SECRET = previous;
});

test("webhook silently accepts unauthorized private sender", async () => {
  const previousSecret = process.env.TELEGRAM_SECRET;
  const previousUser = process.env.TELEGRAM_USER_ID;
  process.env.TELEGRAM_SECRET = "expected-secret";
  process.env.TELEGRAM_USER_ID = "123";
  const res = responseRecorder();
  await handler(
    {
      method: "POST",
      headers: { "x-telegram-bot-api-secret-token": "expected-secret" },
      body: { update_id: 1, message: { from: { id: 999 }, chat: { id: 999, type: "private" }, text: "/start" } },
    },
    res,
  );
  assert.equal(res.statusCode, 200);
  assert.equal(res.body, "OK");
  if (previousSecret === undefined) delete process.env.TELEGRAM_SECRET;
  else process.env.TELEGRAM_SECRET = previousSecret;
  if (previousUser === undefined) delete process.env.TELEGRAM_USER_ID;
  else process.env.TELEGRAM_USER_ID = previousUser;
});
