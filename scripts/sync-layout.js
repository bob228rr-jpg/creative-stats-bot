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
    fields: "sheets(properties(sheetId),conditionalFormats,data(rowData(values(formattedValue,userEnteredFormat(numberFormat)))))" });
  const sheet = verified.data.sheets[0];
  const rows = sheet.data[0].rowData;
  const headers = rows[layout.headerRow - 1].values.map(cell => cell.formattedValue);
  const timestamp = headers.indexOf("Оновлено: сьогодні"), kingColumn = headers.indexOf("Кінг"), flow = findFlowColumn(headers);
  assert(kingColumn >= 0 && timestamp >= 0);
  assert(sheet.conditionalFormats?.some(rule => rule.ranges.some(range => range.startColumnIndex === flow) &&
    rule.booleanRule?.condition?.values?.[0]?.userEnteredValue?.includes("TODAY()")));
  let names = 0, clocks = 0, missing = 0;
  for (const row of rows.slice(layout.headerRow)) {
    const cells = row.values || [];
    const value = cells[timestamp]?.formattedValue;
    if (value) { assert.match(value, /^\d{1,2}:\d{2}$/); clocks++; }
    const id = cells[flow]?.formattedValue?.match(/(?:^|\s)(\d{6,24})(?=\s|$)/)?.[1];
    if (!id) continue;
    const match = accounts.get(id);
    if (match?.length === 1 && match[0].name) {
      assert.equal(cells[kingColumn]?.formattedValue, match[0].name);
      names++;
    } else missing++;
  }
  console.log("Workbook verified", { names, clocks, missing, accounts: accounts.size });
}

syncLayout().catch(error => {
  console.error("Workbook setup failed", String(error.message).slice(0, 240));
  process.exitCode = 1;
});
