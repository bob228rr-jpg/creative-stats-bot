import { getBaseConfig, getSheetsConfig } from "./config.js";
import { isoNow, periodTargetDate } from "./dates.js";
import { parseReport } from "./parser.js";
import { recognizeReportImage, reportContent, reportImageFileId, shouldRecognizeImage } from "./report-input.js";
import { getSheetsStore } from "./sheets.js";
import { TelegramClient } from "./telegram.js";
import { LaunchConflict, parseLaunch } from "./launch.js";

const PERIOD_LABELS = {
  today: "Сегодня",
  yesterday: "Вчера",
  total: "За всё время",
};

const LAUNCH_BUTTON = "➕ Добавить запуск";
const LAUNCH_HELP = "Пришли название креатива, ID кабинета (6–24 цифры) и домен. Можно разделить их пробелами или переносами строк.\n\nПетрГемШурК3 1083642978012171 frevyfins.frostcraft.space\n\nВыйти из добавления запуска — /cancel.";
function menu() {
  return { reply_markup: { keyboard: [[{ text: LAUNCH_BUTTON }]], resize_keyboard: true } };
}

const HELP_TEXT = [
  "Я обновляю статистику креативов по уникальному домену.",
  "",
  "Просто перешлите таблицу из CoreFlow.",
  "Я сразу полностью заменю статистику за сегодня в листе «Шур».",
  "Для нового запуска пришлите название креатива, ID кабинета и домен в одном сообщении.",
  "",
  "Быстрый формат строки:",
  "domain.example 7 2 1 4",
  "Порядок: домен, лиды, работа, апрувы, отказы.",
  "",
  "Если в отчёте есть ошибка, неизвестный домен или дубль, данные не изменятся.",
].join("\n");

function commandOf(text) {
  const value = String(text || "").trim().toLowerCase();
  const keyboardCommands = new Map([
    [LAUNCH_BUTTON.toLowerCase(), "/launch"],
    ["📅 сегодня", "/today"],
    ["сегодня", "/today"],
    ["◀️ вчера", "/yesterday"],
    ["вчера", "/yesterday"],
    ["📊 за всё время", "/total"],
    ["за всё время", "/total"],
    ["всего", "/total"],
    ["❓ помощь", "/help"],
    ["помощь", "/help"],
  ]);
  if (keyboardCommands.has(value)) return keyboardCommands.get(value);
  const token = value.split(/\s+/)[0];
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

function reportEntities(entities, removedRange) {
  if (!removedRange) return entities;
  const removedLength = removedRange.end - removedRange.start;
  return entities
    .filter((entity) => entity.offset < removedRange.start || entity.offset >= removedRange.end)
    .map((entity) => ({
      ...entity,
      offset: entity.offset >= removedRange.end ? entity.offset - removedLength : entity.offset,
    }));
}

export function automaticReportProblems(parsed, matching) {
  return [
    ...parsed.errors.map((item) => `${item.domain || `строка ${item.line || "?"}`}: ${errorReason(item.reason)}`),
    ...matching.notFound.map((domain) => `${domain}: домен отсутствует в листе «Шур»`),
    ...matching.duplicates.map((item) => `${item.domain}: дубль в строках ${item.rows.join(", ")}`),
  ];
}

async function handleCommand({ command, update, telegram, store }) {
  const message = update.message;
  const chatId = message.chat.id;
  if (command === "/launch") {
    await store.setSession(message.from.id, "launch", "", update.update_id);
    await telegram.sendMessage(chatId, LAUNCH_HELP, menu());
    return true;
  }
  if (command === "/cancel") {
    await store.setSession(message.from.id, "", "", update.update_id);
    await telegram.sendMessage(chatId, "Добавление запуска отменено. Можно пересылать статистику.", menu());
    return true;
  }
  if (command === "/start") {
    await telegram.sendMessage(chatId, `Привет! 👋\n\n${HELP_TEXT}`, menu());
    return true;
  }
  if (command === "/help") {
    await telegram.sendMessage(chatId, HELP_TEXT, menu());
    return true;
  }
  const period = { "/today": "today", "/yesterday": "yesterday", "/total": "total" }[command];
  if (period) {
    await telegram.sendMessage(
      chatId,
      "Бот теперь всегда записывает статистику за сегодня. Просто перешлите таблицу из CoreFlow.",
      menu(),
    );
    return true;
  }
  if (command === "/status") {
    const status = await store.status();
    await telegram.sendMessage(
      chatId,
      `✅ Google Sheets подключён.\nТаблица: ${status.spreadsheetTitle}\nЛист: ${status.mainSheet}\nСтрока заголовков: ${status.headerRow}\nСтатистические колонки: ${status.statsColumns}`,
      menu(),
    );
    return true;
  }
  return false;
}

async function handleReport({ update, telegram, store, report }) {
  const message = update.message;
  const period = "today";
  const targetDate = periodTargetDate(period);
  const sheetsConfig = getSheetsConfig();
  const parsed = parseReport(
    report.text,
    reportEntities(report.entities),
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
      menu(),
    );
    return;
  }
  const matching = await store.getMainMatch(parsed.entries);
  const blockingProblems = automaticReportProblems(parsed, matching);
  if (blockingProblems.length) {
    await telegram.sendMessage(
      message.chat.id,
      `⚠️ Данные не изменены. Исправьте отчёт или таблицу:\n${blockingProblems.slice(0, 8).join("\n")}`,
      menu(),
    );
    return;
  }
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
      source: report.source,
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
    await telegram.sendMessage(
      message.chat.id,
      "Отчёт слишком большой для одной загрузки.",
      menu(),
    );
    return;
  }
  const created = await store.createPending(pending);
  if (!created.created) return;
  const claimed = await store.claimPending(pending.id, message.from.id);
  if (claimed.state !== "claimed") return;
  try {
    const result = await store.commitPending(claimed.record);
    await telegram.sendMessage(
      message.chat.id,
      `✅ Статистика за сегодня внесена. Доменов: ${result.updated}.${result.cleared ? `\nОчищено старых строк: ${result.cleared}.` : ""}`,
      menu(),
    );
  } catch (error) {
    await store.markPendingError(claimed.record, error).catch(() => undefined);
    await telegram.sendMessage(
      message.chat.id,
      "⚠️ Данные не изменены из-за ошибки записи. Перешлите отчёт ещё раз.",
      menu(),
    );
    throw error;
  }
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
      `✅ Готово. Обновлено доменов: ${result.updated}.${result.cleared ? `\nОчищено старых строк: ${result.cleared}.` : ""}\nПериод: ${PERIOD_LABELS[claimed.record.period]}${claimed.record.targetDate ? ` (${claimed.record.targetDate})` : ""}.`,
    );
  } catch (error) {
    await store.markPendingError(claimed.record, error).catch(() => undefined);
    await telegram.editMessage(
      chatId,
      messageId,
      "⚠️ Запись не завершена. Перешлите отчёт ещё раз.",
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
  if (!message) return;
  await handleIncomingMessage({ update, telegram, store });
}

export async function handleIncomingMessage({ update, telegram, store }) {
  const message = update.message;
  let report = reportContent(message);
  const command = commandOf(report?.text);
  if (command.startsWith("/")) {
    const handled = await handleCommand({ command, update, telegram, store });
    if (!handled) await telegram.sendMessage(message.chat.id, "Неизвестная команда. Используйте /help.", menu());
    return;
  }
  const waiting = (await store.getSession(message.from.id))?.period === "launch";
  const launch = report && parseLaunch(report.text);
  if (waiting && !launch) {
    await telegram.sendMessage(message.chat.id, LAUNCH_HELP, menu());
    return;
  }
  const fileId = reportImageFileId(message);
  if (!launch && fileId && shouldRecognizeImage(report)) {
    await telegram.sendMessage(message.chat.id, "🔎 Распознаю пересланную таблицу…", menu());
    try {
      const bytes = await telegram.downloadFile(fileId);
      const text = await recognizeReportImage(bytes);
      if (text) report = { text, entities: [], source: "ocr" };
    } catch (error) {
      console.error("telegram_ocr_failed", { error: String(error?.message || error).slice(0, 300) });
      await telegram.sendMessage(
        message.chat.id,
        "Не удалось распознать эту картинку. Попробуйте переслать оригинал без сжатия или отправить текст.",
        menu(),
      );
      return;
    }
  }
  if (!report) {
    await telegram.sendMessage(
      message.chat.id,
      "Не удалось найти таблицу в сообщении. Перешлите исходное сообщение из CoreFlow.",
      menu(),
    );
    return;
  }
  if (launch) {
    let result;
    try {
      result = await store.addLaunch(launch);
    } catch (error) {
      if (!(error instanceof LaunchConflict)) throw error;
      await telegram.sendMessage(message.chat.id, error.message, menu());
      return;
    }
    if (waiting) await store.setSession(message.from.id, "", "", update.update_id);
    await telegram.sendMessage(message.chat.id, `${result.isNew ? "✅ Запуск добавлен" : "Запуск уже есть"} · Шур, строка ${result.row}\n${launch.creative}${result.king ? " · " + result.king : ""}`, menu());
    return;
  }
  await handleReport({ update, telegram, store, report });
}
