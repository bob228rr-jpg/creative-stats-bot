import { randomBytes } from "node:crypto";
import { google } from "googleapis";
import { getSheetsConfig } from "./config.js";
import { isoNow, kyivSheetDateTime } from "./dates.js";
import { indexKingAccounts, LaunchConflict, parseLaunch } from "./launch.js";
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

export const HIDDEN_TECHNICAL_SHEETS = [
  "СТАТА_ПО_ДНЯМ",
  "СТАТА_ВСЕГО",
  "ЖУРНАЛ",
  "_BOT_PENDING",
  "_BOT_SESSION",
  "_BOT_UPDATES",
];

const HIDDEN_SHEETS = new Set(HIDDEN_TECHNICAL_SHEETS);
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

function kingFormula(name, statusColumn, rowNumber, separator) {
  const quoted = String(name).replaceAll('"', '""');
  return `=IF($${columnLetter(statusColumn)}${rowNumber}${separator}"${quoted}"${separator}"")`;
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

function clearValuesRequest(sheetId, startRowIndex, endRowIndex, startColumnIndex, endColumnIndex) {
  return {
    repeatCell: {
      range: {
        sheetId,
        startRowIndex,
        endRowIndex,
        startColumnIndex,
        endColumnIndex,
      },
      cell: {},
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

function hasValue(value) {
  return value !== undefined && value !== null && value !== "";
}

export function snapshotReplacementPlan({ period, targetDate, matched, mainRows, dailyRows, totalRows, layout }) {
  const matchedRowNumbers = new Set(matched.map((item) => item.rowNumber));
  const mainStartRowNumber = layout.headerRow + 1;
  const mainMetricIndexes = MAIN_STATS_HEADERS.map((header) => layout.statsIndexes[header]);
  const clearedMainCount = period === "today"
    ? mainRows.filter((row, index) => {
        const rowNumber = mainStartRowNumber + index;
        return !matchedRowNumbers.has(rowNumber) && mainMetricIndexes.some((columnIndex) => hasValue(row?.[columnIndex]));
      }).length
    : 0;

  return {
    clearMain: period === "today" && mainRows.length > 0,
    clearedMainCount,
    dailyRowIndexes: period === "today" || period === "yesterday"
      ? dailyRows
          .map((row, index) => (String(row[0]) === String(targetDate) ? index + 1 : null))
          .filter(Number.isInteger)
      : [],
    totalRowIndexes: period === "total"
      ? totalRows.map((row, index) => (hasValue(row[0]) ? index + 1 : null)).filter(Number.isInteger)
      : [],
  };
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
      fields: "properties(title,locale),sheets(properties(sheetId,title,hidden,gridProperties),conditionalFormats,tables(tableId,range,columnProperties(columnIndex,columnType)))",
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

    const missingHeaders = [...MAIN_STATS_HEADERS, "Кінг"].filter((header) => !existing.has(normalizeHeader(header)));
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

    const hideRequests = [...HIDDEN_SHEETS]
      .map((title) => sheets.get(title))
      .filter((properties) => properties && !properties.hidden)
      .map((properties) => ({
        updateSheetProperties: {
          properties: { sheetId: properties.sheetId, hidden: true },
          fields: "hidden",
        },
      }));
    if (hideRequests.length) {
      await this.api.spreadsheets.batchUpdate({
        spreadsheetId: this.config.spreadsheetId,
        requestBody: { requests: hideRequests },
      });
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
    const kingSheet = sheets.get(this.config.mainSheet + " King");
    const mainRange = `${quoteSheet(this.config.mainSheet)}!A${headerRow + 1}:${columnLetter(finalHeaders.length - 1)}`;
    const ranges = [mainRange];
    if (kingSheet) ranges.push(quoteSheet(kingSheet.title));
    const sources = await this.api.spreadsheets.values.batchGet({
      spreadsheetId: this.config.spreadsheetId,
      ranges, valueRenderOption: "FORMATTED_VALUE",
    });
    const [mainData, kingData] = sources.data.valueRanges;
    const mainRows = mainData.values || [];
    const dataEndRow = headerRow + Math.max(mainRows.length, 1);
    const kingColumn = headerIndexes.get("кінг");
    const timestamp = statsIndexes["Оновлено: сьогодні"];
    const statusColumn = headerIndexes.get("статус");
    if (!Number.isInteger(statusColumn)) throw new Error("Не найдена колонка «Статус».");
    const mainInfo = metadata.data.sheets.find(s => s.properties.sheetId === main.sheetId);
    const separator = (1.5).toLocaleString((metadata.data.properties.locale || "en_US").replaceAll("_", "-")).includes(",") ? ";" : ",";
    const formattedEnd = Math.max(kingColumn, statsEnd) + 1;
    const cellBorder = {
      style: "SOLID",
      color: { red: 0.38, green: 0.38, blue: 0.38 },
    };
    const formatting = [
      {
        repeatCell: {
          range: {
            sheetId: main.sheetId,
            startRowIndex: headerRow - 1,
            endRowIndex: headerRow,
            startColumnIndex: statsStart,
            endColumnIndex: formattedEnd,
          },
          cell: {
            userEnteredFormat: {
              backgroundColor: { red: 1, green: 0, blue: 0.6039 },
              textFormat: { foregroundColor: { red: 1, green: 1, blue: 1 }, bold: true },
              horizontalAlignment: "CENTER",
              verticalAlignment: "MIDDLE",
              wrapStrategy: "WRAP",
              borders: {
                top: { style: "SOLID" },
                bottom: { style: "SOLID" },
                left: { style: "SOLID" },
                right: { style: "SOLID" },
              },
            },
          },
          fields: "userEnteredFormat(backgroundColor,textFormat,horizontalAlignment,verticalAlignment,wrapStrategy,borders)",
        },
      },
      {
        repeatCell: {
          range: {
            sheetId: main.sheetId,
            startRowIndex: headerRow,
            endRowIndex: dataEndRow,
            startColumnIndex: statsStart,
            endColumnIndex: formattedEnd,
          },
          cell: {
            userEnteredFormat: {
              horizontalAlignment: "CENTER",
              verticalAlignment: "MIDDLE",
              wrapStrategy: "WRAP",
              textFormat: { bold: true },
              borders: {
                top: cellBorder,
                bottom: cellBorder,
                left: cellBorder,
                right: cellBorder,
              },
            },
          },
          fields: "userEnteredFormat(horizontalAlignment,verticalAlignment,wrapStrategy,textFormat.bold,borders)",
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
          properties: { pixelSize: 145 },
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
    const columnRange = (column) => ({ sheetId: main.sheetId, startRowIndex: headerRow,
      startColumnIndex: column, endColumnIndex: column + 1 });
    formatting.push({
      repeatCell: { range: columnRange(timestamp), cell: { userEnteredFormat: {
        numberFormat: { type: "DATE_TIME", pattern: "hh:mm" },
      } }, fields: "userEnteredFormat.numberFormat" },
    });
    {
      const ref = col => `$${columnLetter(col)}${headerRow + 1}`;
      const oldFormula = `=(${ref(statusColumn)}=TRUE)*ISNUMBER(${ref(statsIndexes["Сьогодні: Ліди"])})*(INT(${ref(timestamp)})=TODAY())`;
      const formula = `=${ref(statusColumn)}=TRUE`;
      const rules = mainInfo.conditionalFormats || [];
      const formulaOf = rule => rule.booleanRule?.condition?.values?.[0]?.userEnteredValue;
      for (let index = rules.length - 1; index >= 0; index--) {
        if (formulaOf(rules[index]) === oldFormula && rules[index].ranges?.length === 1 &&
          rules[index].ranges[0].startColumnIndex === flowColumn && rules[index].ranges[0].endColumnIndex === flowColumn + 1) {
          formatting.push({ deleteConditionalFormatRule: { sheetId: main.sheetId, index } });
        }
      }
      if (!rules.some(rule => formulaOf(rule) === formula && rule.ranges?.some(range =>
        !range.startColumnIndex && range.endColumnIndex === formattedEnd && range.startRowIndex === headerRow))) {
        formatting.push({ addConditionalFormatRule: { index: 0, rule: {
          ranges: [{ ...columnRange(0), endColumnIndex: formattedEnd }], booleanRule: {
            condition: { type: "CUSTOM_FORMULA", values: [{ userEnteredValue: formula }] },
            format: { backgroundColor: { red: 219/255, green: 196/255, blue: 1 } },
          },
        } } });
      }
    }
    formatting.push({ updateDimensionProperties: { range: { sheetId: main.sheetId, dimension: "COLUMNS",
      startIndex: kingColumn, endIndex: kingColumn + 1 }, properties: { pixelSize: 210 }, fields: "pixelSize" } },
      { updateDimensionProperties: { range: { sheetId: main.sheetId, dimension: "ROWS", startIndex: headerRow - 1,
        endIndex: headerRow }, properties: { pixelSize: 50 }, fields: "pixelSize" } });
    const accounts = indexKingAccounts(kingData?.values || []);
    mainRows.forEach((row, offset) => {
      const stamp = row[timestamp];
      if (typeof stamp === "string" && /^\d{4}-\d\d-\d\dT.*Z$/.test(stamp) && Number.isFinite(Date.parse(stamp))) {
        formatting.push(updateCellsRequest(main.sheetId, headerRow + offset, timestamp, [kyivSheetDateTime(stamp)]));
      }
      const id = String(row[flowColumn] || "").match(/(?:^|\s)(\d{6,24})(?=\s|$)/)?.[1];
      const hits = accounts.get(id);
      if (hits?.length === 1 && hits[0].name) {
        formatting.push(updateCellsRequest(main.sheetId, headerRow + offset, kingColumn,
          [kingFormula(hits[0].name, statusColumn, headerRow + offset + 1, separator)]));
      } else if (kingData && (row[kingColumn] || id)) {
        formatting.push(clearValuesRequest(main.sheetId, headerRow + offset, headerRow + offset + 1, kingColumn, kingColumn + 1));
      }
    });
    await this.api.spreadsheets.batchUpdate({
      spreadsheetId: this.config.spreadsheetId,
      requestBody: { requests: formatting },
    });

    return {
      spreadsheetTitle: metadata.data.properties.title,
      separator,
      headerRow,
      mainSheetId: main.sheetId,
      kingSheet,
      mainProperties: main,
      mainTable: mainInfo.tables?.find(table => flowColumn >= (table.range.startColumnIndex || 0)
        && flowColumn < table.range.endColumnIndex && (table.range.startRowIndex || 0) === headerRow - 1),
      headers: finalHeaders,
      statsIndexes,
      technical: Object.fromEntries(
        Object.keys(TECHNICAL_SCHEMAS).map((title) => [title, sheets.get(title).sheetId]),
      ),
    };
  }

  async addLaunch(launch, date = new Date()) {
    const layout = await this.ensureSetup();
    const { kingSheet, headerRow, mainSheetId, mainTable } = layout;
    if (!kingSheet) throw new LaunchConflict("Не найден лист «Шур King».");
    const result = await this.api.spreadsheets.values.batchGet({
      spreadsheetId: this.config.spreadsheetId,
      ranges: [`${quoteSheet(this.config.mainSheet)}!A${headerRow}:${columnLetter(layout.headers.length - 1)}`, quoteSheet(kingSheet.title)],
      valueRenderOption: "FORMATTED_VALUE",
    });
    const [[headers, ...rows], kingRows] = result.data.valueRanges.map(range => range.values || []);
    const matches = indexKingAccounts(kingRows).get(launch.id) || [];
    if (matches.length !== 1) throw new LaunchConflict(matches.length
      ? "ID кабинета повторяется на «Шур King». Проверь строки с этим ID."
      : "Не нашёл ID кабинета на «Шур King». Проверь цифры в сообщении.");
    const [account] = matches;
    if (account.creative && account.creative !== launch.creative) {
      throw new LaunchConflict(`У кабинета уже указан другой креатив — ${account.creative}.`);
    }
    const columns = indexesByHeaders(headers);
    const flow = findFlowColumn(headers);
    const column = name => {
      const index = columns.get(normalizeHeader(name));
      if (!Number.isInteger(index)) throw new LaunchConflict(`На рабочем листе не найдена колонка «${name}».`);
      return index;
    };
    const sameDomain = buildDomainIndex(rows, flow, 0).get(launch.domain) || [];
    if (sameDomain.length > 1 || (sameDomain.length && parseLaunch(rows[sameDomain[0]][flow])?.flow !== launch.flow)) {
      throw new LaunchConflict("Домен уже указан в другом потоке на «Шур». Проверь его перед запуском.");
    }
    const isNew = !sameDomain.length;
    const occupied = row => row.some(value => !["", "FALSE", false, null, undefined].includes(value));
    const rowIndex = headerRow + (isNew ? rows.findLastIndex(occupied) + 1 : sameDomain[0]);
    const requests = [];
    const write = (col, value) => requests.push(updateCellsRequest(mainSheetId, rowIndex, col, [value]));
    if (isNew) {
      if (rowIndex >= layout.mainProperties.gridProperties.rowCount) requests.push({
        appendDimension: { sheetId: mainSheetId, dimension: "ROWS", length: 1 },
      });
      if (mainTable && rowIndex >= mainTable.range.endRowIndex) requests.push({
        updateTable: { table: { tableId: mainTable.tableId, range: { ...mainTable.range, endRowIndex: rowIndex + 1 } }, fields: "range" },
      });
      if (!mainTable && rowIndex > headerRow && rowIndex - headerRow >= rows.length) {
        const rowRange = i => ({ sheetId: mainSheetId, startRowIndex: i, endRowIndex: i + 1, startColumnIndex: 0, endColumnIndex: headers.length });
        for (const pasteType of ["PASTE_FORMAT", "PASTE_DATA_VALIDATION"]) requests.push({
          copyPaste: { source: rowRange(rowIndex - 1), destination: rowRange(rowIndex), pasteType },
        });
      } else if (rowIndex > headerRow && columns.has(normalizeHeader(MAIN_STATS_HEADERS[0]))) {
        const statsRange = i => ({ sheetId: mainSheetId, startRowIndex: i, endRowIndex: i + 1,
          startColumnIndex: column(MAIN_STATS_HEADERS[0]), endColumnIndex: column("Кінг") + 1 });
        requests.push({ copyPaste: { source: statsRange(rowIndex - 1), destination: statsRange(rowIndex),
          pasteType: "PASTE_FORMAT" } });
      }
      write(column("Назва крео"), launch.creative);
      write(flow, launch.flow);
      const dateColumn = column("Дата запуску");
      write(dateColumn, Math.floor(kyivSheetDateTime(date)));
      const dateType = mainTable?.columnProperties?.find(col => (col.columnIndex || 0) === dateColumn - (mainTable.range.startColumnIndex || 0))?.columnType;
      if (!dateType || dateType === "COLUMN_TYPE_UNSPECIFIED") requests.push({ repeatCell: { range: { sheetId: mainSheetId, startRowIndex: rowIndex, endRowIndex: rowIndex + 1,
        startColumnIndex: dateColumn, endColumnIndex: dateColumn + 1 }, cell: { userEnteredFormat: {
          numberFormat: { type: "DATE", pattern: "dd.mm.yyyy" } } }, fields: "userEnteredFormat.numberFormat" } });
      write(column("Статус"), true);
      if (launch.offer) write(column("Офер"), launch.offer);
    }
    if (account.name) write(column("Кінг"), kingFormula(account.name, column("Статус"), rowIndex + 1, layout.separator || ","));
    const { rowIndex: r, columnIndex: c } = account;
    requests.push({ repeatCell: {
      range: { sheetId: kingSheet.sheetId, startRowIndex: r, endRowIndex: r + 1, startColumnIndex: c, endColumnIndex: c + 1 },
      cell: { userEnteredFormat: { backgroundColorStyle: { rgbColor: { red: 217/255, green: 234/255, blue: 211/255 } } } },
      fields: "userEnteredFormat.backgroundColorStyle",
    } }, updateCellsRequest(kingSheet.sheetId, r, c + 1, [launch.creative]));
    await this.api.spreadsheets.batchUpdate({ spreadsheetId: this.config.spreadsheetId, requestBody: { requests } });
    if (isNew && mainTable && rowIndex >= mainTable.range.endRowIndex) setupCache.delete(this.config.spreadsheetId);
    return { isNew, row: rowIndex + 1, king: account.name };
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
    const replacement = snapshotReplacementPlan({
      period: record.period,
      targetDate: record.targetDate,
      matched: payload.matched,
      mainRows,
      dailyRows,
      totalRows,
      layout,
    });

    if (replacement.clearMain) {
      requests.push(
        clearValuesRequest(
          layout.mainSheetId,
          layout.headerRow,
          layout.headerRow + mainRows.length,
          layout.statsIndexes[MAIN_STATS_HEADERS[0]],
          layout.statsIndexes[MAIN_STATS_HEADERS.at(-1)] + 1,
        ),
      );
    }
    for (const rowIndex of replacement.dailyRowIndexes) {
      requests.push(clearValuesRequest(layout.technical["СТАТА_ПО_ДНЯМ"], rowIndex, rowIndex + 1, 0, 7));
    }
    for (const rowIndex of replacement.totalRowIndexes) {
      requests.push(clearValuesRequest(layout.technical["СТАТА_ВСЕГО"], rowIndex, rowIndex + 1, 0, 6));
    }

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
            [kyivSheetDateTime(now)],
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
    return { updated: payload.matched.length, cleared: replacement.clearedMainCount, record: done };
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
