import { timingSafeEqual } from "node:crypto";

export function safeEqual(actual, expected) {
  if (typeof actual !== "string" || typeof expected !== "string") return false;
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function isPrivateAuthorizedUpdate(update, allowedUserId) {
  const message = update?.message || update?.edited_message;
  const callback = update?.callback_query;
  const from = message?.from || callback?.from;
  const chat = message?.chat || callback?.message?.chat;
  return Boolean(
    from &&
      chat &&
      String(from.id) === String(allowedUserId) &&
      chat.type === "private" &&
      String(chat.id) === String(allowedUserId),
  );
}
