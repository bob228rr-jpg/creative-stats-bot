function truncate(text, limit = 4096) {
  const value = String(text);
  return value.length <= limit ? value : `${value.slice(0, limit - 20)}\n…сообщение сокращено`;
}

export class TelegramClient {
  constructor({ botToken, telegramApiBase }) {
    this.baseUrl = `${telegramApiBase}/bot${botToken}`;
    this.fileBaseUrl = `${telegramApiBase}/file/bot${botToken}`;
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

  async downloadFile(fileId, maxBytes = 12 * 1024 * 1024) {
    const file = await this.call("getFile", { file_id: fileId });
    if (!file?.file_path) throw new Error("Telegram getFile did not return a file path.");
    const response = await fetch(`${this.fileBaseUrl}/${file.file_path}`, {
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`Telegram file download failed (${response.status}).`);
    const declaredSize = Number(response.headers.get("content-length") || 0);
    if (declaredSize > maxBytes) throw new Error("Telegram image is too large for OCR.");
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) throw new Error("Telegram image is too large for OCR.");
    return bytes;
  }
}
