import assert from "node:assert/strict";
import test from "node:test";
import { isPrivateAuthorizedUpdate, safeEqual } from "../lib/security.js";

test("safeEqual rejects missing and unequal secrets", () => {
  assert.equal(safeEqual("same", "same"), true);
  assert.equal(safeEqual("same", "different"), false);
  assert.equal(safeEqual(undefined, "same"), false);
});

test("only the configured user in private chat is authorized", () => {
  const update = { message: { from: { id: 123 }, chat: { id: 123, type: "private" } } };
  assert.equal(isPrivateAuthorizedUpdate(update, "123"), true);
  assert.equal(isPrivateAuthorizedUpdate(update, "456"), false);
  update.message.chat.type = "group";
  assert.equal(isPrivateAuthorizedUpdate(update, "123"), false);
});
