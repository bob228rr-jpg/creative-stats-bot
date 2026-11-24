// Run once when releasing changes to the existing workbook.
import assert from "node:assert/strict";
import { getSheetsStore } from "../lib/sheets.js";
import { indexKingAccounts } from "../lib/launch.js";
import { findFlowColumn } from "../lib/matching.js";

async function syncLayout() {
  const store = getSheetsStore();
  const spreadsheetId = store.config.spreadsheetId;
  const main = store.config.mainSheet;
  const king = main + " King";
  const quote = title => "'" + title.replaceAll("'", "''") + "'";
  const meta = await store.spreadsheetMetadata();
  assert(meta.data.sheets.some(s => s.properties.title === king), "Missing king tab");
  const { data } = await store.api.spreadsheets.values.get({ spreadsheetId, range: quote(king) });
  const kingRows = data.values || [];
  const accounts = indexKingAccounts(kingRows);
  assert(accounts.size > 0, "No account groups recognized on king sheet");
  const layout = await store.ensureSetup({ force: true });
  const verified = await store.api.spreadsheets.get({ spreadsheetId, ranges: [quote(main)],
    fields: "sheets(properties(sheetId),conditionalFormats,data(rowData(values(formattedValue,effectiveValue,effectiveFormat(backgroundColor),userEnteredFormat(numberFormat,textFormat,horizontalAlignment,verticalAlignment,wrapStrategy,borders)))))" });
  const sheet = verified.data.sheets[0];
  const rows = sheet.data[0].rowData;
  const headers = rows[layout.headerRow - 1].values.map(cell => cell.formattedValue);
  const timestamp = headers.indexOf("Оновлено: сьогодні"), kingColumn = headers.indexOf("Кінг"), flow = findFlowColumn(headers);
  assert(kingColumn >= 0 && timestamp >= 0);
  const status = headers.indexOf("Статус"), statsStart = headers.indexOf("Сьогодні: Ліди");
  assert(status >= 0 && statsStart >= 0);
  assert(sheet.conditionalFormats?.some(rule => rule.ranges.some(range =>
    !range.startColumnIndex && range.endColumnIndex === kingColumn + 1 && range.startRowIndex === layout.headerRow) &&
    rule.booleanRule?.condition?.type === "CUSTOM_FORMULA"));
  let names = 0, clocks = 0, missing = 0, inactive = 0;
  const activeIds = new Set();
  for (const row of rows.slice(layout.headerRow)) {
    const cells = row.values || [];
    const value = cells[timestamp]?.formattedValue;
    if (value) { assert.match(value, /^\d{1,2}:\d{2}$/); clocks++; }
    const id = cells[flow]?.formattedValue?.match(/(?:^|\s)(\d{6,24})(?=\s|$)/)?.[1];
    if (!id) continue;
    for (const cell of cells.slice(statsStart, kingColumn + 1)) {
      const format = cell.userEnteredFormat;
      assert.equal(format?.horizontalAlignment, "CENTER");
      assert.equal(format?.verticalAlignment, "MIDDLE");
      assert.equal(format?.wrapStrategy, "WRAP");
      assert.equal(format?.textFormat?.bold, true);
      for (const edge of ["top", "bottom", "left", "right"]) assert.equal(format?.borders?.[edge]?.style, "SOLID");
    }
    if (!cells[status]?.effectiveValue?.boolValue) {
      assert.equal(cells[kingColumn]?.formattedValue || "", "");
      inactive++;
      continue;
    }
    for (const cell of cells.slice(0, kingColumn + 1)) {
      const color = cell.effectiveFormat?.backgroundColor;
      assert.deepEqual([color?.red, color?.green, color?.blue].map(x => Math.round(255*x)), [219,196,255]);
    }
    activeIds.add(id);
    const match = accounts.get(id);
    if (match?.length === 1 && match[0].name) {
      assert.equal(cells[kingColumn]?.formattedValue, match[0].name);
      names++;
    } else missing++;
  }
  const kingGrid = await store.api.spreadsheets.get({ spreadsheetId, ranges: [quote(king)],
    fields: "sheets(conditionalFormats,data(rowData(values(formattedValue,effectiveFormat(backgroundColor)))))" });
  const kingTab = kingGrid.data.sheets[0];
  assert(kingTab.conditionalFormats?.some(rule => rule.booleanRule?.condition?.values?.[0]?.userEnteredValue.includes("creative-stats:king-status")));
  let green = 0, other = 0;
  for (const [id, hits] of accounts) {
    for (const {rowIndex, columnIndex} of hits) {
      const cell = kingTab.data[0].rowData[rowIndex].values[columnIndex];
      const rgb = cell.effectiveFormat?.backgroundColor || {};
      const isGreen = [rgb.red, rgb.green, rgb.blue].map(value => Math.round(255 * value)).join(",") === "217,234,211";
      assert.equal(isGreen, activeIds.has(id), `Unexpected color at row ${rowIndex + 1}, column ${columnIndex + 1}`);
      if (isGreen) green++; else other++;
    }
  }
  console.log("Workbook verified", { names, clocks, missing, inactive, green, other });
}

syncLayout().catch(error => {
  console.error("Workbook setup failed", String(error.message).slice(0, 240));
  process.exitCode = 1;
});
