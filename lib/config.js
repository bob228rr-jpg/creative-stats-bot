const REQUIRED_BASE = ["BOT_TOKEN", "TELEGRAM_USER_ID", "TELEGRAM_SECRET"];
const REQUIRED_SHEETS = [
  "SPREADSHEET_ID",
  "MAIN_SHEET",
  "GOOGLE_CLIENT_EMAIL",
  "GOOGLE_PRIVATE_KEY",
];

function readRequired(names) {
  const missing = names.filter((name) => !process.env[name]?.trim());
  if (missing.length) {
    throw new Error(`Missing environment variables: ${missing.join(", ")}`);
  }
}

export function getBaseConfig() {
  readRequired(REQUIRED_BASE);
  return {
    botToken: process.env.BOT_TOKEN.trim(),
    allowedUserId: String(process.env.TELEGRAM_USER_ID).trim(),
    telegramSecret: process.env.TELEGRAM_SECRET,
    telegramApiBase: (process.env.TELEGRAM_API_BASE || "https://api.telegram.org").replace(/\/$/, ""),
  };
}

export function getSheetsConfig() {
  readRequired(REQUIRED_SHEETS);
  const configuredRow = Number.parseInt(process.env.HEADER_ROW || "", 10);
  return {
    spreadsheetId: process.env.SPREADSHEET_ID.trim(),
    mainSheet: process.env.MAIN_SHEET.trim(),
    clientEmail: process.env.GOOGLE_CLIENT_EMAIL.trim(),
    privateKey: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, "\n"),
    headerRow: Number.isInteger(configuredRow) && configuredRow > 0 ? configuredRow : null,
    strictStatusSum: /^true$/i.test(process.env.STRICT_STATUS_SUM || "false"),
  };
}

export function getConfigPresence() {
  const names = [...REQUIRED_BASE, ...REQUIRED_SHEETS];
  return Object.fromEntries(names.map((name) => [name, Boolean(process.env[name]?.trim())]));
}
