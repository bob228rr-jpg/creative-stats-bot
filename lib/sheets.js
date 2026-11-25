import { randomBytes } from "node:crypto";
import { google } from "googleapis";
import { getSheetsConfig } from "./config.js";
import { isoNow, kyivSheetDateTime } from "./dates.js";
import { indexKingAccounts, kingAccountHeader, LaunchConflict, parseLaunch } from "./launch.js";
import { approvalRatio, buildDomainIndex, findFlowColumn, matchReport, normalizeHeader } from "./matching.js";
import { claimPendingRecord, completePendingRecord, PENDING_STATUSES } from "./pending.js";

export const MAIN_STATS_HEADERS = [
  "Сьогодні: Ліди",
  "Сьогодні: Робота",
  "Сьогодні: Апруви",
  "Сьогодні: Відмови",
  "Сьогодні: Апрув %",
  "Оновлено: сьогодні",
];

const NEW_COLUMN_WIDTHS = {
  "Сьогодні: Ліди": 70,
  "Сьогодні: Робота": 77,
  "Сьогодні: Апруви": 55,
  "Сьогодні: Відмови": 58,
  "Сьогодні: Апрув %": 65,
  "Оновлено: сьогодні": 84,
  "Кінг": 105,
};

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

const accountGreen = { red: 217/255, green: 234/255, blue: 211/255 };
function isAccountGreen(color) {
  return color && ["red", "green", "blue"].every(key =>
    Math.round(color[key] * 255) === Math.round(accountGreen[key] * 255));
}

function extendedValue(value) {
  if (value === null || value === undefined || value === "") return {};
  if (typeof value === "number") return { numberValue: value };
  if (typeof value === "boolean") return { boolValue: value };
  if (typeof value === "string" && value.startsWith("=")) return { formulaValue: value };
  return { stringValue: String(value) };
}

function statsFormatRequest(range, numberFormat) {
  const border = { style: "SOLID", color: { red: 0.38, green: 0.38, blue: 0.38 } };
  const format = {
    horizontalAlignment: "CENTER", verticalAlignment: "MIDDLE", wrapStrategy: "WRAP",
    textFormat: { bold: true }, borders: { top: border, bottom: border, left: border, right: border },
  };
  const fields = ["horizontalAlignment", "verticalAlignment", "wrapStrategy", "textFormat.bold", "borders"];
  if (numberFormat) {
    format.numberFormat = numberFormat;
    fields.push("numberFormat");
  }
  return { repeatCell: { range, cell: { userEnteredFormat: format }, fields: `userEnteredFormat(${fields.join(",")})` } };
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
    const promise = this.#performSetup(force);
    setupCache.set(key, { createdAt: Date.now(), promise });
    try {
      this.layout = await promise;
      return this.layout;
    } catch (error) {
      setupCache.delete(key);
      throw error;
    }
  }

  async #performSetup(force) {
    let [metadata, initial] = await Promise.all([
      this.spreadsheetMetadata(),
      this.api.spreadsheets.values.get({
        spreadsheetId: this.config.spreadsheetId,
        range: `${quoteSheet(this.config.mainSheet)}!1:${Math.max(20, this.config.headerRow || 0)}`,
      }),
    ]);
    let sheets = sheetMap(metadata);
    const main = sheets.get(this.config.mainSheet);
    if (!main) throw new Error(`Лист «${this.config.mainSheet}» не найден.`);

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

    const configure = force || legacyIndexes.length || missingHeaders.length || addRequests.length;
    let finalHeaders = headers;
    if (configure) {
      const data = Object.entries(TECHNICAL_SCHEMAS).map(([title, values]) => ({
        range: quoteSheet(title) + "!A1", values: [values],
      }));
      await this.api.spreadsheets.values.batchUpdate({
        spreadsheetId: this.config.spreadsheetId, requestBody: { valueInputOption: "RAW", data },
      });
      if (missingHeaders.length) finalHeaders = [...headers, ...missingHeaders];
    }
    const headerIndexes = indexesByHeaders(finalHeaders);
    const statsIndexes = Object.fromEntries(
      MAIN_STATS_HEADERS.map((header) => [header, headerIndexes.get(normalizeHeader(header))]),
    );
    if (Object.values(statsIndexes).some((index) => !Number.isInteger(index))) {
      throw new Error("Не удалось создать все статистические колонки.");
    }

    const statsStart = Math.min(...Object.values(statsIndexes));
    const statsEnd = Math.max(...Object.values(statsIndexes));
    const flowColumn = findFlowColumn(finalHeaders);
    const kingSheet = sheets.get(this.config.mainSheet + " King");
    const mainRange = `${quoteSheet(this.config.mainSheet)}!A${headerRow + 1}:${columnLetter(finalHeaders.length - 1)}`;
    const kingColumn = headerIndexes.get("кінг");
    const colValues = col => {
      const letter = columnLetter(col);
      return `${quoteSheet(main.title)}!${letter}${headerRow + 1}:${letter}`;
    };
    const ranges = configure ? [mainRange] : [colValues(flowColumn)];
    if (kingSheet) ranges.push(quoteSheet(kingSheet.title));
    const [sources, formulas] = await Promise.all([
      this.api.spreadsheets.values.batchGet({
        spreadsheetId: this.config.spreadsheetId, ranges, valueRenderOption: "FORMATTED_VALUE",
      }),
      !configure && kingSheet && this.api.spreadsheets.values.get({
        spreadsheetId: this.config.spreadsheetId, range: colValues(kingColumn), valueRenderOption: "FORMULA",
      }),
    ]);
    const [mainData, kingData] = sources.data.valueRanges;
    const mainRows = mainData.values || [];
    // Compare formulas (including names hidden by an unchecked status) on routine refreshes.
    const kingFormulas = formulas?.data?.values || [];
    const timestamp = statsIndexes["Оновлено: сьогодні"];
    const statusColumn = headerIndexes.get("статус");
    if (!Number.isInteger(statusColumn)) throw new Error("Не найдена колонка «Статус».");
    const mainInfo = metadata.data.sheets.find(s => s.properties.sheetId === main.sheetId);
    const separator = (1.5).toLocaleString((metadata.data.properties.locale || "en_US").replaceAll("_", "-")).includes(",") ? ";" : ",";
    const formattedEnd = Math.max(kingColumn, statsEnd) + 1;
    const formatting = configure ? [
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
      statsFormatRequest({ sheetId: main.sheetId, startRowIndex: headerRow,
        startColumnIndex: statsStart, endColumnIndex: formattedEnd }),
      {
        repeatCell: {
          range: {
            sheetId: main.sheetId,
            startRowIndex: headerRow,
            startColumnIndex: statsIndexes["Сьогодні: Апрув %"],
            endColumnIndex: statsIndexes["Сьогодні: Апрув %"] + 1,
          },
          cell: { userEnteredFormat: { numberFormat: { type: "PERCENT", pattern: "0.0%" } } },
          fields: "userEnteredFormat.numberFormat",
        },
      },
    ] : [];
    const columnRange = (column) => ({ sheetId: main.sheetId, startRowIndex: headerRow,
      startColumnIndex: column, endColumnIndex: column + 1 });
    if (configure) formatting.push({
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
    // Existing widths belong to the sheet owner, including after a forced setup.
    for (const header of missingHeaders) {
      const index = headerIndexes.get(normalizeHeader(header));
      formatting.push({ updateDimensionProperties: {
        range: { sheetId: main.sheetId, dimension: "COLUMNS", startIndex: index, endIndex: index + 1 },
        properties: { pixelSize: NEW_COLUMN_WIDTHS[header] }, fields: "pixelSize",
      } });
    }
    const accounts = indexKingAccounts(kingData?.values || []);
    if (kingSheet) {
      const kingInfo = metadata.data.sheets.find(s => s.properties.sheetId === kingSheet.sheetId);
      formatting.push(...await this.kingStatusFormatting(kingInfo, kingData.values || [], accounts,
        { flowColumn, statusColumn, headerRow, separator }));
    }
    const rowCount = Math.max(mainRows.length, kingFormulas.length);
    for (let offset = 0; offset < rowCount; offset++) {
      const row = mainRows[offset] || [];
      const stamp = configure && row[timestamp];
      if (typeof stamp === "string" && /^\d{4}-\d\d-\d\dT.*Z$/.test(stamp) && Number.isFinite(Date.parse(stamp))) {
        formatting.push(updateCellsRequest(main.sheetId, headerRow + offset, timestamp, [kyivSheetDateTime(stamp)]));
      }
      if (!kingData) continue;
      const id = String(row[configure ? flowColumn : 0] || "").match(/(?:^|\s)(\d{6,24})(?=\s|$)/)?.[1];
      const hits = accounts.get(id);
      const name = hits?.length === 1 && hits[0].name;
      const formula = name ? kingFormula(name, statusColumn, headerRow + offset + 1, separator) : "";
      const current = configure ? row[kingColumn] : kingFormulas[offset]?.[0];
      if (formula !== (current || "") || (configure && id && !formula)) {
        formatting.push(updateCellsRequest(main.sheetId, headerRow + offset, kingColumn, [formula]));
      }
    }
    if (formatting.length) await this.api.spreadsheets.batchUpdate({
      spreadsheetId: this.config.spreadsheetId, requestBody: { requests: formatting },
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

  async kingStatusFormatting(sheet, rows, accounts, { flowColumn, statusColumn, headerRow, separator }) {
    const { sheetId, title } = sheet.properties;
    const columns = new Map();
    rows.forEach((row, r) => row.forEach((_, c) => {
      if (kingAccountHeader(row, c) && !columns.has(c + 1)) columns.set(c + 1, r + 1);
    }));
    const marker = 'N("creative-stats:king-status")';
    const mainColumn = column => {
      const letter = columnLetter(column);
      const range = quoteSheet(this.config.mainSheet) + "!" + letter + (headerRow + 1) + ":" + letter;
      return 'INDIRECT("' + range.replaceAll('"', '""') + '")';
    };
    const requests = [];
    const existing = (sheet.conditionalFormats || []).map((rule, index) => ({
      index, range: rule.ranges?.[0], formula: rule.booleanRule?.condition?.values?.[0]?.userEnteredValue || "",
    })).filter(rule => rule.formula.includes(marker));
    const keep = new Set();
    for (const [c, start] of columns) {
      const id = "$" + columnLetter(c) + (start + 1);
      const formula = `=IF(${id}=""${separator}FALSE${separator}COUNTIFS(${mainColumn(statusColumn)}${separator}TRUE${separator}${mainColumn(flowColumn)}${separator}"* "&TO_TEXT(${id})&" *")>${marker})`;
      const match = existing.find(rule => rule.formula === formula && rule.range?.startColumnIndex === c &&
        rule.range.startRowIndex === start && rule.range.endColumnIndex === c + 1 && rule.range.endRowIndex == null);
      if (match) { keep.add(match.index); continue; }
      requests.push({ addConditionalFormatRule: { index: 0, rule: {
        ranges: [{ sheetId, startRowIndex: start, startColumnIndex: c, endColumnIndex: c + 1 }],
        booleanRule: { condition: { type: "CUSTOM_FORMULA", values: [{userEnteredValue: formula}] },
          format: { backgroundColor: accountGreen } },
      } } });
    }
    for (const { index } of existing) {
      if (!keep.has(index)) requests.unshift({ deleteConditionalFormatRule: { sheetId, index } });
    }
    if (!requests.length || !accounts.size) return requests;
    // Retire only the old static green on actual account IDs; preserve other manual fills.
    const cells = [...accounts.values()].flat();
    const grid = await this.api.spreadsheets.get({ spreadsheetId: this.config.spreadsheetId,
      ranges: [...columns].filter(([, start]) => start < rows.length).map(([c, start]) => {
        const letter = columnLetter(c);
        return `${quoteSheet(title)}!${letter}${start + 1}:${letter}${rows.length}`;
      }),
      fields: "sheets(data(startRow,startColumn,rowData(values(userEnteredFormat(backgroundColor,backgroundColorStyle)))))",
    });
    const byColumn = new Map(grid.data.sheets[0].data.map(block => [block.startColumn || 0, block]));
    for (const { rowIndex, columnIndex } of cells) {
      const block = byColumn.get(columnIndex);
      const format = block?.rowData?.[rowIndex - (block.startRow || 0)]?.values?.[0]?.userEnteredFormat;
      if (!isAccountGreen(format?.backgroundColorStyle?.rgbColor ?? format?.backgroundColor)) continue;
      requests.push({ repeatCell: {
        range: { sheetId, startRowIndex: rowIndex, endRowIndex: rowIndex + 1, startColumnIndex: columnIndex, endColumnIndex: columnIndex + 1 },
        cell: {}, fields: "userEnteredFormat(backgroundColor,backgroundColorStyle)",
      } });
    }
    return requests;
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
      const statisticColumns = [...MAIN_STATS_HEADERS, "Кінг"]
        .map(header => ({ header, index: columns.get(normalizeHeader(header)) }))
        .filter(({ index }) => Number.isInteger(index));
      if (!mainTable && rowIndex > headerRow && rowIndex - headerRow >= rows.length) {
        const copy = (start, end, pasteType) => {
          const range = i => ({ sheetId: mainSheetId, startRowIndex: i, endRowIndex: i + 1,
            startColumnIndex: start, endColumnIndex: end });
          requests.push({ copyPaste: { source: range(rowIndex - 1), destination: range(rowIndex), pasteType } });
        };
        let start = 0;
        const stats = statisticColumns.map(({index}) => index).sort((a, b) => a - b);
        for (const end of [...stats, headers.length]) {
          if (start < end) copy(start, end, "PASTE_FORMAT");
          start = end + 1;
        }
        copy(0, headers.length, "PASTE_DATA_VALIDATION");
      }
      for (const { header, index } of statisticColumns) {
        const numberFormat = header === "Сьогодні: Апрув %" ? { type: "PERCENT", pattern: "0.0%" }
          : header === "Оновлено: сьогодні" ? { type: "DATE_TIME", pattern: "hh:mm" } : undefined;
        requests.push(statsFormatRequest({ sheetId: mainSheetId, startRowIndex: rowIndex, endRowIndex: rowIndex + 1,
          startColumnIndex: index, endColumnIndex: index + 1 }, numberFormat));
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
    requests.push(updateCellsRequest(kingSheet.sheetId, r, c + 1, [launch.creative]));
    await this.api.spreadsheets.batchUpdate({ spreadsheetId: this.config.spreadsheetId, requestBody: { requests } });
    if (isNew && mainTable && rowIndex >= mainTable.range.endRowIndex) setupCache.delete(this.config.spreadsheetId);
    return { isNew, row: rowIndex + 1, king: account.name };
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
    const claimToken = randomBytes(12).toString("hex");
    const claim = claimPendingRecord(current, claimToken, isoNow());
    if (!claim.claimed) return { state: current.status.toLowerCase(), record: current };
    await this.updatePending(claim.record);
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

  async saveReport(record) {
    const layout = await this.ensureSetup();
    const payload = record.payload;
    if (!payload?.matched?.length) throw new Error("В заявке нет сопоставленных строк.");

    const spreadsheetId = this.config.spreadsheetId;
    // Rotate one named range on the hidden journal in the same batch as the data.
    // An overlapping writer using the previous version must reread before saving.
    const versionName = "_CREATIVE_STATS_REPORT_VERSION";
    const versions = await this.api.spreadsheets.get({ spreadsheetId, fields: "namedRanges(name,namedRangeId,range)" });
    const previous = versions.data.namedRanges?.find(range => range.name === versionName);
    const journalId = layout.technical["ЖУРНАЛ"];
    if (previous && previous.range.sheetId !== journalId) throw new Error("Имя диапазона журнала уже занято.");

    const total = record.period === "total";
    const history = total ? "СТАТА_ВСЕГО" : "СТАТА_ПО_ДНЯМ";
    const snapshot = await this.api.spreadsheets.values.batchGet({
      spreadsheetId, valueRenderOption: "UNFORMATTED_VALUE",
      ranges: [quoteSheet(this.config.mainSheet), quoteSheet(history) + (total ? "!A2:F" : "!A2:G"),
        quoteSheet("ЖУРНАЛ") + "!O2:O"],
    });
    const [main, historyData, receipts] = snapshot.data.valueRanges;
    const savedCount = (receipts.values || []).filter(row => row[0] === record.id).length;
    if (savedCount) {
      if (record.rowNumber) await this.updatePending(completePendingRecord(record, isoNow()));
      return { updated: savedCount, cleared: 0, notFound: [], duplicates: [] };
    }

    const rows = main.values || [];
    const headerRow = locateHeaderRow(rows, this.config.headerRow);
    const headers = rows[headerRow - 1];
    const indexes = indexesByHeaders(headers);
    const mainRows = rows.slice(headerRow);
    const statsIndexes = Object.fromEntries(MAIN_STATS_HEADERS.map(header => [header, indexes.get(normalizeHeader(header))]));
    if (Object.values(statsIndexes).some(index => !Number.isInteger(index))) throw new Error("Изменились заголовки статистики.");
    const currentLayout = { ...layout, headerRow, statsIndexes };
    const matching = matchReport(payload.matched, buildDomainIndex(mainRows, findFlowColumn(headers), headerRow + 1));
    if (matching.notFound.length || matching.duplicates.length) return matching;
    const dailyRows = total ? [] : historyData.values || [];
    const totalRows = total ? historyData.values || [] : [];
    const requests = [];
    if (previous) requests.push({ deleteNamedRange: { namedRangeId: previous.namedRangeId } });
    requests.push({ addNamedRange: { namedRange: { name: versionName,
      range: { sheetId: journalId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 1 } } } });
    const journalEntries = [];
    const now = isoNow();
    const replacement = snapshotReplacementPlan({
      period: record.period,
      targetDate: record.targetDate,
      matched: matching.matched,
      mainRows,
      dailyRows,
      totalRows,
      layout: currentLayout,
    });

    if (replacement.clearMain) {
      for (const column of Object.values(statsIndexes)) {
        requests.push(clearValuesRequest(layout.mainSheetId, headerRow, headerRow + mainRows.length, column, column + 1));
      }
    }
    for (const rowIndex of replacement.dailyRowIndexes) {
      requests.push(clearValuesRequest(layout.technical["СТАТА_ПО_ДНЯМ"], rowIndex, rowIndex + 1, 0, 7));
    }
    for (const rowIndex of replacement.totalRowIndexes) {
      requests.push(clearValuesRequest(layout.technical["СТАТА_ВСЕГО"], rowIndex, rowIndex + 1, 0, 6));
    }

    const historyRows = historyData.values || [];
    const historyByDomain = new Map();
    historyRows.forEach((row, i) => {
      if (!total && String(row[0]) !== record.targetDate) return;
      const domain = String(row[total ? 0 : 1] || "").toLowerCase();
      if (domain && !historyByDomain.has(domain)) historyByDomain.set(domain, i);
    });
    let nextRow = historyRows.length + 1;
    const sheetTime = kyivSheetDateTime(now);
    const statColumns = MAIN_STATS_HEADERS.map(header => statsIndexes[header]);
    const contiguous = statColumns.every((col, i) => col === statColumns[0] + i);
    for (const item of matching.matched) {
      const metrics = [item.leads, item.work, item.approved, item.rejected];
      const mainRow = item.rowNumber - headerRow - 1;
      let old = ["", "", "", ""];
      if (record.period === "today") {
        old = mainStats(mainRows[mainRow], currentLayout);
        const values = [...metrics, approvalRatio(item.approved, item.leads), sheetTime];
        if (contiguous) {
          requests.push(updateCellsRequest(layout.mainSheetId, item.rowNumber - 1, statColumns[0], values));
        } else {
          statColumns.forEach((col, i) => requests.push(updateCellsRequest(layout.mainSheetId, item.rowNumber - 1, col, [values[i]])));
        }
      }
      const existing = historyByDomain.get(item.domain);
      if (existing !== undefined) old = rowStats(historyRows[existing], total ? 1 : 2);
      const key = total ? [item.domain] : [record.targetDate, item.domain];
      requests.push(updateCellsRequest(layout.technical[history], existing === undefined ? nextRow++ : existing + 1,
        0, [...key, ...metrics, now]));
      journalEntries.push([now, record.userId, record.period, record.targetDate || "", item.domain,
        ...old, ...metrics, "REPLACE_SNAPSHOT", record.id, ""]);
    }

    requests.push(appendCellsRequest(journalId, journalEntries));
    if (record.rowNumber) {
      const done = completePendingRecord(record, now);
      requests.push(updateCellsRequest(layout.technical["_BOT_PENDING"], record.rowNumber - 1, 0, pendingToRow(done)));
    }
    await this.api.spreadsheets.batchUpdate({
      spreadsheetId: this.config.spreadsheetId,
      requestBody: { requests },
    });
    return { updated: matching.matched.length, cleared: replacement.clearedMainCount, notFound: [], duplicates: [] };
  }

  async status({ configure = false } = {}) {
    const layout = await this.ensureSetup({ force: configure });
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
