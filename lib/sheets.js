import { randomBytes } from "node:crypto";
import { google } from "googleapis";
import { getSheetsConfig } from "./config.js";
import { isoNow } from "./dates.js";
import { approvalRatio, buildDomainIndex, findFlowColumn, matchReport, normalizeHeader } from "./matching.js";
import { canClaimPending, PENDING_STATUSES } from "./pending.js";

export const MAIN_STATS_HEADERS = [
  "Сьогодні: Ліди",
  "Сьогодні: Робота",
  "Сьогодні: Апруви",
  "Сьогодні: Відмови",
  "Сьогодні: Апрув %",
  "Оновлено: сьогодні",
];

export const LEGACY_TOTAL_HEADERS = [
  "Всього: Ліди",
  "Всього: Робота",
  "Всього: Апруви",
  "Всього: Відмови",
  "Всього: Апрув %",
  "Оновлено: всього",
];

const TECHNICAL_SCHEMAS = {
  "СТАТА_ПО_ДНЯМ": ["Дата", "Домен", "Ліди", "Робота", "Апруви", "Відмови", "Оновлено"],
  "СТАТА_ВСЕГО": ["Домен", "Ліди", "Робота", "Апруви", "Відмови", "Оновлено"],
  "ЖУРНАЛ": [
    "Timestamp",
    "User ID",
    "Період",
    "Дата",
    "Домен",
    "Старі ліди",
    "Стара робота",
    "Старі апруви",
    "Старі відмови",
    "Нові ліди",
    "Нова робота",
    "Нові апруви",
    "Нові відмови",
    "Дія",
    "ID завантаження",
    "Помилка",
  ],
  "_BOT_PENDING": [
    "ID",
    "Період",
    "Дата",
    "Payload JSON",
    "User ID",
    "Статус",
    "Створено",
    "Оновлено",
    "Claim token",
    "Помилка",
    "Update ID",
  ],
  "_BOT_SESSION": ["User ID", "Період", "Дата", "Оновлено", "Update ID"],
  "_BOT_UPDATES": ["Update ID", "Статус", "Оновлено"],
};

const HIDDEN_SHEETS = new Set(["_BOT_PENDING", "_BOT_SESSION", "_BOT_UPDATES"]);
const setupCache = new Map();

function quoteSheet(title) {
  return `'${String(title).replace(/'/g, "''")}'`;
}

function columnLetter(index) {
  let value = index + 1;
  let result = "";
  while (value > 0) {
    const remainder = (value - 1) % 26;
    result = String.fromCharCode(65 + remainder) + result;
    value = Math.floor((value - 1) / 26);
  }
  return result;
}

function extendedValue(value) {
  if (value === null || value === undefined || value === "") return {};
  if (typeof value === "number") return { numberValue: value };
  if (typeof value === "boolean") return { boolValue: value };
  if (typeof value === "string" && value.startsWith("=")) return { formulaValue: value };
  return { stringValue: String(value) };
}

function updateCellsRequest(sheetId, rowIndex, columnIndex, values) {
  return {
    updateCells: {
      range: {
        sheetId,
        startRowIndex: rowIndex,
        endRowIndex: rowIndex + 1,
        startColumnIndex: columnIndex,
        endColumnIndex: columnIndex + values.length,
      },
      rows: [{ values: values.map((value) => ({ userEnteredValue: extendedValue(value) })) }],
      fields: "userEnteredValue",
    },
  };
}

function appendCellsRequest(sheetId, rows) {
  return {
    appendCells: {
      sheetId,
      rows: rows.map((row) => ({
        values: row.map((value) => ({ userEnteredValue: extendedValue(value) })),
      })),
      fields: "userEnteredValue",
    },
  };
}

function locateHeaderRow(rows, configuredRow) {
  if (configuredRow) return configuredRow;
  for (let index = 0; index < Math.min(rows.length, 20); index += 1) {
    try {
      findFlowColumn(rows[index] || []);
      return index + 1;
    } catch {
      // Continue detecting.
    }
  }
  throw new Error("Не удалось обнаружить строку заголовков. Укажите HEADER_ROW в Vercel.");
}

function sheetMap(metadata) {
  return new Map(metadata.data.sheets.map((sheet) => [sheet.properties.title, sheet.properties]));
}

function indexesByHeaders(headers) {
  const result = new Map();
  headers.forEach((header, index) => result.set(normalizeHeader(header), index));
  return result;
}

function pendingFromRow(row, rowNumber) {
  if (!row?.[0]) return null;
  let payload = null;
  try {
    payload = JSON.parse(row[3] || "null");
  } catch {
    payload = null;
  }
  return {
    id: row[0],
    period: row[1],
    targetDate: row[2] || null,
    payload,
    userId: String(row[4] || ""),
    status: row[5],
    createdAt: row[6],
    updatedAt: row[7],
    claimToken: row[8] || "",
    error: row[9] || "",
    updateId: row[10] || "",
    rowNumber,
  };
}

function pendingToRow(record) {
  return [
    record.id,
    record.period,
    record.targetDate || "",
    JSON.stringify(record.payload),
    record.userId,
    record.status,
    record.createdAt,
    record.updatedAt,
    record.claimToken || "",
    record.error || "",
    record.updateId || "",
  ];
}

function mainStats(row, layout) {
  if (!row) return ["", "", "", ""];
  return ["Ліди", "Робота", "Апруви", "Відмови"].map(
    (metric) => row[layout.statsIndexes[`Сьогодні: ${metric}`]] ?? 0,
  );
}

function rowStats(row, offset) {
  if (!row) return ["", "", "", ""];
  return [row[offset] ?? 0, row[offset + 1] ?? 0, row[offset + 2] ?? 0, row[offset + 3] ?? 0];
}

export class SheetsStore {
  constructor(config = getSheetsConfig()) {
    this.config = config;
    const auth = new google.auth.JWT({
      email: config.clientEmail,
      key: config.privateKey,
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });
    this.api = google.sheets({ version: "v4", auth });
    this.layout = null;
  }

  async spreadsheetMetadata() {
    return this.api.spreadsheets.get({
      spreadsheetId: this.config.spreadsheetId,
      fields: "properties.title,sheets.properties(sheetId,title,hidden,gridProperties)",
    });
  }

  async ensureSetup({ force = false } = {}) {
    const key = this.config.spreadsheetId;
    const cached = setupCache.get(key);
    if (!force && cached && Date.now() - cached.createdAt < 5 * 60_000) {
      this.layout = await cached.promise;
      return this.layout;
    }
    const promise = this.#performSetup();
    setupCache.set(key, { createdAt: Date.now(), promise });
    try {
      this.layout = await promise;
      return this.layout;
    } catch (error) {
      setupCache.delete(key);
      throw error;
    }
  }

  async #performSetup() {
    let metadata = await this.spreadsheetMetadata();
    let sheets = sheetMap(metadata);
    const main = sheets.get(this.config.mainSheet);
    if (!main) throw new Error(`Лист «${this.config.mainSheet}» не найден.`);

    const initial = await this.api.spreadsheets.values.get({
      spreadsheetId: this.config.spreadsheetId,
      range: `${quoteSheet(this.config.mainSheet)}!1:20`,
    });
    const initialRows = initial.data.values || [];
    const headerRow = locateHeaderRow(initialRows, this.config.headerRow);
    let headers = initialRows[headerRow - 1] || [];
    findFlowColumn(headers);

    let existing = indexesByHeaders(headers);
    const legacyIndexes = LEGACY_TOTAL_HEADERS
      .map((header) => existing.get(normalizeHeader(header)))
      .filter(Number.isInteger)
      .sort((left, right) => right - left);
    if (legacyIndexes.length) {
      await this.api.spreadsheets.batchUpdate({
        spreadsheetId: this.config.spreadsheetId,
        requestBody: {
          requests: legacyIndexes.map((index) => ({
            deleteDimension: {
              range: {
                sheetId: main.sheetId,
                dimension: "COLUMNS",
                startIndex: index,
                endIndex: index + 1,
              },
            },
          })),
        },
      });
      const pruned = await this.api.spreadsheets.values.get({
        spreadsheetId: this.config.spreadsheetId,
        range: `${quoteSheet(this.config.mainSheet)}!${headerRow}:${headerRow}`,
      });
      headers = pruned.data.values?.[0] || [];
      existing = indexesByHeaders(headers);
    }

    const missingHeaders = MAIN_STATS_HEADERS.filter((header) => !existing.has(normalizeHeader(header)));
    if (missingHeaders.length) {
      const startColumn = headers.length;
      const endColumn = startColumn + missingHeaders.length - 1;
      await this.api.spreadsheets.values.update({
        spreadsheetId: this.config.spreadsheetId,
        range: `${quoteSheet(this.config.mainSheet)}!${columnLetter(startColumn)}${headerRow}:${columnLetter(endColumn)}${headerRow}`,
        valueInputOption: "RAW",
        requestBody: { values: [missingHeaders] },
      });
    }

    const addRequests = [];
    for (const title of Object.keys(TECHNICAL_SCHEMAS)) {
      if (!sheets.has(title)) {
        addRequests.push({ addSheet: { properties: { title, hidden: HIDDEN_SHEETS.has(title) } } });
      }
    }
    if (addRequests.length) {
      await this.api.spreadsheets.batchUpdate({
        spreadsheetId: this.config.spreadsheetId,
        requestBody: { requests: addRequests },
      });
      metadata = await this.spreadsheetMetadata();
      sheets = sheetMap(metadata);
    }

    const technicalUpdates = [];
    for (const [title, schema] of Object.entries(TECHNICAL_SCHEMAS)) {
      technicalUpdates.push({ range: `${quoteSheet(title)}!A1`, values: [schema] });
    }
    await this.api.spreadsheets.values.batchUpdate({
      spreadsheetId: this.config.spreadsheetId,
      requestBody: { valueInputOption: "RAW", data: technicalUpdates },
    });

    const refreshed = await this.api.spreadsheets.values.get({
      spreadsheetId: this.config.spreadsheetId,
      range: `${quoteSheet(this.config.mainSheet)}!${headerRow}:${headerRow}`,
    });
    const finalHeaders = refreshed.data.values?.[0] || [];
    const headerIndexes = indexesByHeaders(finalHeaders);
    const statsIndexes = Object.fromEntries(
      MAIN_STATS_HEADERS.map((header) => [header, headerIndexes.get(normalizeHeader(header))]),
    );
    if (Object.values(statsIndexes).some((index) => !Number.isInteger(index))) {
      throw new Error("Не удалось создать все статистические колонки.");
    }

    const statsStart = Math.min(...Object.values(statsIndexes));
    const statsEnd = Math.max(...Object.values(statsIndexes));
    const numericEnd = statsIndexes["Сьогодні: Апрув %"] + 1;
    const flowColumn = findFlowColumn(finalHeaders);
    const flowValues = await this.api.spreadsheets.values.get({
      spreadsheetId: this.config.spreadsheetId,
      range: `${quoteSheet(this.config.mainSheet)}!${columnLetter(flowColumn)}${headerRow + 1}:${columnLetter(flowColumn)}`,
    });
    const dataEndRow = headerRow + Math.max(flowValues.data.values?.length || 0, 1);
    const cellBorder = {
      style: "SOLID",
      color: { red: 0.72, green: 0.72, blue: 0.72 },
    };
    const formatting = [
      {
        repeatCell: {
          range: {
            sheetId: main.sheetId,
            startRowIndex: headerRow - 1,
            endRowIndex: headerRow,
            startColumnIndex: statsStart,
            endColumnIndex: statsEnd + 1,
          },
          cell: {
            userEnteredFormat: {
              backgroundColor: { red: 1, green: 0, blue: 0.6039 },
              textFormat: { foregroundColor: { red: 1, green: 1, blue: 1 }, bold: true },
              horizontalAlignment: "CENTER",
              borders: {
                top: { style: "SOLID" },
                bottom: { style: "SOLID" },
                left: { style: "SOLID" },
                right: { style: "SOLID" },
              },
            },
          },
          fields: "userEnteredFormat(backgroundColor,textFormat,horizontalAlignment,borders)",
        },
      },
      {
        repeatCell: {
          range: {
            sheetId: main.sheetId,
            startRowIndex: headerRow,
            endRowIndex: dataEndRow,
            startColumnIndex: statsStart,
            endColumnIndex: statsEnd + 1,
          },
          cell: {
            userEnteredFormat: {
              horizontalAlignment: "CENTER",
              verticalAlignment: "MIDDLE",
              borders: {
                top: cellBorder,
                bottom: cellBorder,
                left: cellBorder,
                right: cellBorder,
              },
            },
          },
          fields: "userEnteredFormat(horizontalAlignment,verticalAlignment,borders)",
        },
      },
      {
        repeatCell: {
          range: {
            sheetId: main.sheetId,
            startRowIndex: headerRow,
            endRowIndex: dataEndRow,
            startColumnIndex: statsStart,
            endColumnIndex: numericEnd,
          },
          cell: { userEnteredFormat: { textFormat: { bold: true } } },
          fields: "userEnteredFormat.textFormat.bold",
        },
      },
      {
        repeatCell: {
          range: {
            sheetId: main.sheetId,
            startRowIndex: headerRow,
            endRowIndex: dataEndRow,
            startColumnIndex: statsIndexes["Сьогодні: Апрув %"],
            endColumnIndex: statsIndexes["Сьогодні: Апрув %"] + 1,
          },
          cell: { userEnteredFormat: { numberFormat: { type: "PERCENT", pattern: "0.0%" } } },
          fields: "userEnteredFormat.numberFormat",
        },
      },
      {
        updateDimensionProperties: {
          range: {
            sheetId: main.sheetId,
            dimension: "COLUMNS",
            startIndex: statsStart,
            endIndex: numericEnd,
          },
          properties: { pixelSize: 125 },
          fields: "pixelSize",
        },
      },
      {
        updateDimensionProperties: {
          range: {
            sheetId: main.sheetId,
            dimension: "COLUMNS",
            startIndex: statsIndexes["Оновлено: сьогодні"],
            endIndex: statsIndexes["Оновлено: сьогодні"] + 1,
          },
          properties: { pixelSize: 190 },
          fields: "pixelSize",
        },
      },
    ];
    await this.api.spreadsheets.batchUpdate({
      spreadsheetId: this.config.spreadsheetId,
      requestBody: { requests: formatting },
    });

    return {
      spreadsheetTitle: metadata.data.properties.title,
      headerRow,
      mainSheetId: main.sheetId,
      headers: finalHeaders,
      statsIndexes,
      technical: Object.fromEntries(
        Object.keys(TECHNICAL_SCHEMAS).map((title) => [title, sheets.get(title).sheetId]),
      ),
    };
  }

  async getMainMatch(entries) {
    const layout = await this.ensureSetup();
    const response = await this.api.spreadsheets.values.get({
      spreadsheetId: this.config.spreadsheetId,
      range: `${quoteSheet(this.config.mainSheet)}!A${layout.headerRow}:ZZ`,
      valueRenderOption: "UNFORMATTED_VALUE",
    });
    const rows = response.data.values || [];
    const headers = rows[0] || [];
    const flowColumn = findFlowColumn(headers);
    const dataRows = rows.slice(1);
    const domainIndex = buildDomainIndex(dataRows, flowColumn, layout.headerRow + 1);
    return { ...matchReport(entries, domainIndex), rows: dataRows, headers };
  }

  async setSession(userId, period, targetDate, updateId) {
    await this.ensureSetup();
    const title = "_BOT_SESSION";
    const response = await this.api.spreadsheets.values.get({
      spreadsheetId: this.config.spreadsheetId,
      range: `${quoteSheet(title)}!A2:E`,
    });
    const rows = response.data.values || [];
    const index = rows.findIndex((row) => String(row[0]) === String(userId));
    const rowNumber = index >= 0 ? index + 2 : rows.length + 2;
    await this.api.spreadsheets.values.update({
      spreadsheetId: this.config.spreadsheetId,
      range: `${quoteSheet(title)}!A${rowNumber}:E${rowNumber}`,
      valueInputOption: "RAW",
      requestBody: { values: [[String(userId), period, targetDate || "", isoNow(), String(updateId)]] },
    });
  }

  async getSession(userId) {
    await this.ensureSetup();
    const response = await this.api.spreadsheets.values.get({
      spreadsheetId: this.config.spreadsheetId,
      range: `${quoteSheet("_BOT_SESSION")}!A2:E`,
    });
    const row = (response.data.values || []).find((value) => String(value[0]) === String(userId));
    return row ? { userId: String(row[0]), period: row[1], targetDate: row[2] || null, updatedAt: row[3] } : null;
  }

  async createPending(record) {
    await this.ensureSetup();
    const existing = await this.getPending(record.id);
    if (existing) return { record: existing, created: false };
    await this.api.spreadsheets.values.append({
      spreadsheetId: this.config.spreadsheetId,
      range: `${quoteSheet("_BOT_PENDING")}!A:K`,
      valueInputOption: "RAW",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: [pendingToRow(record)] },
    });
    return { record, created: true };
  }

  async getPending(id) {
    await this.ensureSetup();
    const response = await this.api.spreadsheets.values.get({
      spreadsheetId: this.config.spreadsheetId,
      range: `${quoteSheet("_BOT_PENDING")}!A2:K`,
      valueRenderOption: "UNFORMATTED_VALUE",
    });
    const rows = response.data.values || [];
    const index = rows.findIndex((row) => String(row[0]) === String(id));
    return index >= 0 ? pendingFromRow(rows[index], index + 2) : null;
  }

  async updatePending(record) {
    if (!record.rowNumber) throw new Error("Pending row number is missing.");
    await this.api.spreadsheets.values.update({
      spreadsheetId: this.config.spreadsheetId,
      range: `${quoteSheet("_BOT_PENDING")}!A${record.rowNumber}:K${record.rowNumber}`,
      valueInputOption: "RAW",
      requestBody: { values: [pendingToRow(record)] },
    });
  }

  async claimPending(id, userId) {
    const current = await this.getPending(id);
    if (!current) return { state: "missing" };
    if (String(current.userId) !== String(userId)) return { state: "forbidden" };
    if (!canClaimPending(current.status)) return { state: current.status.toLowerCase(), record: current };
    const claimToken = randomBytes(12).toString("hex");
    const claimed = {
      ...current,
      status: PENDING_STATUSES.PROCESSING,
      claimToken,
      updatedAt: isoNow(),
      error: "",
    };
    await this.updatePending(claimed);
    const verified = await this.getPending(id);
    if (verified?.claimToken !== claimToken || verified.status !== PENDING_STATUSES.PROCESSING) {
      return { state: "processing", record: verified };
    }
    return { state: "claimed", record: verified };
  }

  async cancelPending(id, userId) {
    const current = await this.getPending(id);
    if (!current) return { state: "missing" };
    if (String(current.userId) !== String(userId)) return { state: "forbidden" };
    if (current.status === PENDING_STATUSES.CANCELLED) return { state: "cancelled", record: current };
    if (current.status !== PENDING_STATUSES.PENDING) return { state: current.status.toLowerCase(), record: current };
    const cancelled = { ...current, status: PENDING_STATUSES.CANCELLED, updatedAt: isoNow() };
    await this.updatePending(cancelled);
    return { state: "cancelled", record: cancelled };
  }

  async markPendingError(record, error) {
    const message = String(error?.message || error || "Unknown error").slice(0, 500);
    await this.updatePending({ ...record, status: PENDING_STATUSES.ERROR, error: message, updatedAt: isoNow() });
  }

  async commitPending(record) {
    const layout = await this.ensureSetup();
    const payload = record.payload;
    if (!payload?.matched?.length) throw new Error("В заявке нет сопоставленных строк.");

    const [mainResponse, dailyResponse, totalResponse, journalResponse] = await Promise.all([
      this.api.spreadsheets.values.get({
        spreadsheetId: this.config.spreadsheetId,
        range: `${quoteSheet(this.config.mainSheet)}!A${layout.headerRow + 1}:ZZ`,
        valueRenderOption: "UNFORMATTED_VALUE",
      }),
      this.api.spreadsheets.values.get({
        spreadsheetId: this.config.spreadsheetId,
        range: `${quoteSheet("СТАТА_ПО_ДНЯМ")}!A2:G`,
        valueRenderOption: "UNFORMATTED_VALUE",
      }),
      this.api.spreadsheets.values.get({
        spreadsheetId: this.config.spreadsheetId,
        range: `${quoteSheet("СТАТА_ВСЕГО")}!A2:F`,
        valueRenderOption: "UNFORMATTED_VALUE",
      }),
      this.api.spreadsheets.values.get({
        spreadsheetId: this.config.spreadsheetId,
        range: `${quoteSheet("ЖУРНАЛ")}!A2:P`,
        valueRenderOption: "UNFORMATTED_VALUE",
      }),
    ]);
    const mainRows = mainResponse.data.values || [];
    const dailyRows = dailyResponse.data.values || [];
    const totalRows = totalResponse.data.values || [];
    const journalRows = journalResponse.data.values || [];
    const requests = [];
    const journalEntries = [];
    const now = isoNow();
    const alreadyJournaled = new Set(journalRows.map((row) => String(row[14] || "")));

    for (const item of payload.matched) {
      let old = ["", "", "", ""];
      if (record.period === "today") {
        const row = mainRows[item.rowNumber - (layout.headerRow + 1)];
        old = mainStats(row, layout);
        const values = {
          "Сьогодні: Ліди": item.leads,
          "Сьогодні: Робота": item.work,
          "Сьогодні: Апруви": item.approved,
          "Сьогодні: Відмови": item.rejected,
          "Сьогодні: Апрув %": approvalRatio(item.approved, item.leads),
        };
        requests.push(
          ...Object.entries(values).map(([header, value]) =>
            updateCellsRequest(layout.mainSheetId, item.rowNumber - 1, layout.statsIndexes[header], [value]),
          ),
          updateCellsRequest(
            layout.mainSheetId,
            item.rowNumber - 1,
            layout.statsIndexes["Оновлено: сьогодні"],
            [now],
          ),
        );
      }

      if (record.period === "today" || record.period === "yesterday") {
        const existingIndex = dailyRows.findIndex(
          (row) => String(row[0]) === String(record.targetDate) && String(row[1]).toLowerCase() === item.domain,
        );
        if (existingIndex >= 0) old = rowStats(dailyRows[existingIndex], 2);
        const rowIndex = existingIndex >= 0 ? existingIndex + 1 : dailyRows.length + 1;
        requests.push(
          updateCellsRequest(layout.technical["СТАТА_ПО_ДНЯМ"], rowIndex, 0, [
            record.targetDate,
            item.domain,
            item.leads,
            item.work,
            item.approved,
            item.rejected,
            now,
          ]),
        );
        if (existingIndex < 0) dailyRows.push([record.targetDate, item.domain]);
      } else {
        const existingIndex = totalRows.findIndex((row) => String(row[0]).toLowerCase() === item.domain);
        if (existingIndex >= 0) old = rowStats(totalRows[existingIndex], 1);
        const rowIndex = existingIndex >= 0 ? existingIndex + 1 : totalRows.length + 1;
        requests.push(
          updateCellsRequest(layout.technical["СТАТА_ВСЕГО"], rowIndex, 0, [
            item.domain,
            item.leads,
            item.work,
            item.approved,
            item.rejected,
            now,
          ]),
        );
        if (existingIndex < 0) totalRows.push([item.domain]);
      }

      if (!alreadyJournaled.has(record.id)) {
        journalEntries.push([
          now,
          record.userId,
          record.period,
          record.targetDate || "",
          item.domain,
          ...old,
          item.leads,
          item.work,
          item.approved,
          item.rejected,
          "REPLACE_SNAPSHOT",
          record.id,
          "",
        ]);
      }
    }

    if (journalEntries.length) {
      requests.push(appendCellsRequest(layout.technical["ЖУРНАЛ"], journalEntries));
    }
    const done = { ...record, status: PENDING_STATUSES.DONE, updatedAt: now, error: "" };
    requests.push(updateCellsRequest(layout.technical["_BOT_PENDING"], record.rowNumber - 1, 0, pendingToRow(done)));

    await this.api.spreadsheets.batchUpdate({
      spreadsheetId: this.config.spreadsheetId,
      requestBody: { requests },
    });
    return { updated: payload.matched.length, record: done };
  }

  async status() {
    const layout = await this.ensureSetup({ force: true });
    return {
      ok: true,
      spreadsheetTitle: layout.spreadsheetTitle,
      mainSheet: this.config.mainSheet,
      headerRow: layout.headerRow,
      statsColumns: MAIN_STATS_HEADERS.length,
    };
  }
}

let singleton;
export function getSheetsStore() {
  if (!singleton) singleton = new SheetsStore();
  return singleton;
}
