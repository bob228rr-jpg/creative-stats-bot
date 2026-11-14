function truncate(text, limit = 4096) {
  const value = String(text);
  return value.length <= limit ? value : `${value.slice(0, limit - 20)}\n…сообщение сокращено`;
}

export class TelegramClient {
  constructor({ botToken, telegramApiBase }) {
    this.baseUrl = `${telegramApiBase}/bot${botToken}`;
  }

  async call(method, body) {
    const response = await fetch(`${this.baseUrl}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.ok) {
      throw new Error(`Telegram ${method} failed (${response.status}): ${payload?.description || "unknown error"}`);
    }
    return payload.result;
  }

  sendMessage(chatId, text, extra = {}) {
    return this.call("sendMessage", {
      chat_id: chatId,
      text: truncate(text),
      disable_web_page_preview: true,
      ...extra,
    });
  }

  editMessage(chatId, messageId, text, extra = {}) {
    return this.call("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text: truncate(text),
      disable_web_page_preview: true,
      ...extra,
    });
  }

  answerCallback(callbackQueryId, text = "") {
    return this.call("answerCallbackQuery", {
      callback_query_id: callbackQueryId,
      text: truncate(text, 200),
    });
  }
}
