import { getBaseConfig, getSheetsConfig } from "./config.js";
import { isoNow, periodTargetDate } from "./dates.js";
import { extractPeriodPrefix, parseReport } from "./parser.js";
import { getSheetsStore } from "./sheets.js";
import { TelegramClient } from "./telegram.js";

const PERIOD_LABELS = {
  today: "Сегодня",
  yesterday: "Вчера",
  total: "За всё время",
};

const HELP_TEXT = [
  "Я обновляю статистику креативов по уникальному домену.",
  "",
  "1. Выберите период: /today, /yesterday или /total.",
  "2. Пришлите весь скопированный отчёт одним сообщением.",
  "3. Проверьте предпросмотр и нажмите «Подтвердить».",
  "",
  "Быстрый формат строки:",
  "domain.example 7 2 1 4",
  "Порядок: домен, лиды, работа, апрувы, отказы.",
  "",
  "Можно написать today / yesterday / total первой строкой отчёта.",
  "Данные записываются как snapshot: повторная загрузка заменяет цифры, а не прибавляет их.",
].join("\n");

function commandOf(text) {
  const token = String(text || "").trim().split(/\s+/)[0].toLowerCase();
  return token.replace(/@[^\s]+$/, "");
}

function errorReason(reason) {
  const labels = {
    invalid_values: "некорректные числа",
    status_sum_exceeds_leads: "сумма статусов больше числа лидов",
    duplicate_domain_in_report: "домен повторяется в отчёте",
    multiple_domains_on_line: "несколько доменов в одной строке",
    ambiguous_numeric_columns: "больше четырёх числовых колонок без понятного заголовка",
    expected_four_metrics: "не найдены четыре показателя",
  };
  return labels[reason] || reason;
}

function buildPreview(record) {
  const payload = record.payload;
  const lines = [
    `Период: ${PERIOD_LABELS[record.period]}${record.targetDate ? ` (${record.targetDate})` : ""}`,
    `Распознано: ${payload.detectedCount}`,
    `Уникально сопоставлено: ${payload.matched.length}`,
    `Не найдено: ${payload.notFound.length}`,
    `Дубли в таблице: ${payload.sheetDuplicates.length}`,
    `Ошибки формата: ${payload.parseErrors.length}`,
  ];
  if (payload.matched.length) {
    lines.push("", "Предпросмотр:");
    for (const item of payload.matched.slice(0, 12)) {
      lines.push(`${item.domain}: ${item.leads} / ${item.work} / ${item.approved} / ${item.rejected}`);
    }
    if (payload.matched.length > 12) lines.push(`…ещё ${payload.matched.length - 12}`);
  }
  if (payload.notFound.length) lines.push("", `Не найдены: ${payload.notFound.slice(0, 8).join(", ")}`);
  if (payload.sheetDuplicates.length) {
    lines.push(
      "",
      `Дубли: ${payload.sheetDuplicates
        .slice(0, 8)
        .map((item) => `${item.domain} (строки ${item.rows.join(", ")})`)
        .join("; ")}`,
    );
  }
  if (payload.parseErrors.length) {
    lines.push(
      "",
      `Ошибки: ${payload.parseErrors
        .slice(0, 8)
        .map((item) => `${item.domain || `строка ${item.line || "?"}`}: ${errorReason(item.reason)}`)
        .join("; ")}`,
    );
  }
  if (!payload.matched.length) lines.push("", "Сохранять нечего — исправьте отчёт или домены в таблице.");
  else lines.push("", "Проверьте цифры. До подтверждения рабочая статистика не меняется.");
  return lines.join("\n");
}

function buttonsFor(record) {
  if (!record.payload.matched.length) return undefined;
  return {
    inline_keyboard: [
      [
        { text: "✅ Подтвердить", callback_data: `save:${record.id}` },
        { text: "✖️ Отмена", callback_data: `cancel:${record.id}` },
      ],
    ],
  };
}

function reportEntities(message, removedRange) {
  if (!removedRange) return message.entities || [];
  const removedLength = removedRange.end - removedRange.start;
  return (message.entities || [])
    .filter((entity) => entity.offset < removedRange.start || entity.offset >= removedRange.end)
    .map((entity) => ({
      ...entity,
      offset: entity.offset >= removedRange.end ? entity.offset - removedLength : entity.offset,
    }));
}

async function handleCommand({ command, update, telegram, store }) {
  const message = update.message;
  const chatId = message.chat.id;
  if (command === "/start") {
    await telegram.sendMessage(chatId, `Привет! 👋\n\n${HELP_TEXT}`);
    return true;
  }
  if (command === "/help") {
    await telegram.sendMessage(chatId, HELP_TEXT);
    return true;
  }
  const period = { "/today": "today", "/yesterday": "yesterday", "/total": "total" }[command];
  if (period) {
    const targetDate = periodTargetDate(period);
    await store.setSession(message.from.id, period, targetDate, update.update_id);
    await telegram.sendMessage(
      chatId,
      `Выбран период: ${PERIOD_LABELS[period]}${targetDate ? ` (${targetDate})` : ""}.\nТеперь пришлите весь отчёт одним сообщением.`,
    );
    return true;
  }
  if (command === "/status") {
    const status = await store.status();
    await telegram.sendMessage(
      chatId,
      `✅ Google Sheets подключён.\nТаблица: ${status.spreadsheetTitle}\nЛист: ${status.mainSheet}\nСтрока заголовков: ${status.headerRow}\nСтатистические колонки: ${status.statsColumns}`,
    );
    return true;
  }
  return false;
}

async function handleReport({ update, telegram, store }) {
  const message = update.message;
  const prefixed = extractPeriodPrefix(message.text);
  const session = prefixed.period ? null : await store.getSession(message.from.id);
  const period = prefixed.period || session?.period;
  if (!period) {
    await telegram.sendMessage(message.chat.id, "Сначала выберите период: /today, /yesterday или /total.");
    return;
  }
  const targetDate = periodTargetDate(period);
  const sheetsConfig = getSheetsConfig();
  const parsed = parseReport(
    prefixed.text,
    reportEntities(message, prefixed.removedRange),
    { strictStatusSum: sheetsConfig.strictStatusSum },
  );
  if (!parsed.entries.length) {
    const detail = parsed.errors
      .slice(0, 5)
      .map((item) => `${item.domain || `строка ${item.line || "?"}`}: ${errorReason(item.reason)}`)
      .join("; ");
    await telegram.sendMessage(
      message.chat.id,
      `Не удалось распознать ни одной безопасной строки.${detail ? `\n${detail}` : ""}\n\nОжидаю домен и четыре целых числа либо таблицу с понятными заголовками.`,
    );
    return;
  }
  const matching = await store.getMainMatch(parsed.entries);
  const now = isoNow();
  const pending = {
    id: `u${update.update_id}`,
    period,
    targetDate,
    payload: {
      detectedCount: parsed.entries.length + parsed.duplicateDomains.length,
      matched: matching.matched,
      notFound: matching.notFound,
      sheetDuplicates: matching.duplicates,
      parseErrors: parsed.errors,
      warnings: parsed.warnings,
    },
    userId: String(message.from.id),
    status: "PENDING",
    createdAt: now,
    updatedAt: now,
    claimToken: "",
    error: "",
    updateId: String(update.update_id),
  };
  if (JSON.stringify(pending.payload).length > 45_000) {
    await telegram.sendMessage(message.chat.id, "Отчёт слишком большой для одной заявки. Разделите его на две части по доменам.");
    return;
  }
  const result = await store.createPending(pending);
  if (!result.created) return;
  await telegram.sendMessage(message.chat.id, buildPreview(pending), { reply_markup: buttonsFor(pending) });
}

async function handleCallback({ update, telegram, store }) {
  const query = update.callback_query;
  const [action, id] = String(query.data || "").split(":", 2);
  if (!id || !["save", "cancel"].includes(action)) {
    await telegram.answerCallback(query.id, "Неизвестное действие");
    return;
  }
  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;
  if (action === "cancel") {
    const result = await store.cancelPending(id, query.from.id);
    await telegram.answerCallback(query.id, result.state === "cancelled" ? "Отменено" : "Заявка уже обработана");
    if (result.state === "cancelled") {
      await telegram.editMessage(chatId, messageId, "✖️ Заявка отменена. Данные не изменены.");
    }
    return;
  }

  await telegram.answerCallback(query.id, "Сохраняю…");
  const claimed = await store.claimPending(id, query.from.id);
  if (claimed.state !== "claimed") {
    const text =
      claimed.state === "done"
        ? "✅ Эта заявка уже сохранена. Повторная запись не выполнялась."
        : claimed.state === "processing"
          ? "⏳ Эта заявка уже обрабатывается."
          : claimed.state === "cancelled"
            ? "✖️ Заявка отменена."
            : "Заявка не найдена или недоступна.";
    await telegram.editMessage(chatId, messageId, text).catch(() => undefined);
    return;
  }
  try {
    const result = await store.commitPending(claimed.record);
    await telegram.editMessage(
      chatId,
      messageId,
      `✅ Готово. Обновлено доменов: ${result.updated}.\nПериод: ${PERIOD_LABELS[claimed.record.period]}${claimed.record.targetDate ? ` (${claimed.record.targetDate})` : ""}.`,
    );
  } catch (error) {
    await store.markPendingError(claimed.record, error).catch(() => undefined);
    await telegram.editMessage(
      chatId,
      messageId,
      "⚠️ Запись не завершена. Заявка сохранена со статусом ERROR — нажмите «Подтвердить» ещё раз после проверки /status.",
      { reply_markup: buttonsFor(claimed.record) },
    );
    throw error;
  }
}

export async function processUpdate(update) {
  const baseConfig = getBaseConfig();
  const telegram = new TelegramClient(baseConfig);
  const store = getSheetsStore();
  if (update.callback_query) {
    await handleCallback({ update, telegram, store });
    return;
  }
  const message = update.message;
  if (!message?.text) {
    if (message) await telegram.sendMessage(message.chat.id, "Пришлите отчёт обычным текстом, не скриншотом и не файлом.");
    return;
  }
  const command = commandOf(message.text);
  if (command.startsWith("/")) {
    const handled = await handleCommand({ command, update, telegram, store });
    if (!handled) await telegram.sendMessage(message.chat.id, "Неизвестная команда. Используйте /help.");
    return;
  }
  await handleReport({ update, telegram, store });
}
