import assert from "node:assert/strict";
import test from "node:test";
import { HIDDEN_TECHNICAL_SHEETS, LEGACY_TOTAL_HEADERS, MAIN_STATS_HEADERS, SheetsStore } from "../lib/sheets.js";

test("main sheet exposes only today's statistics", () => {
  assert.deepEqual(MAIN_STATS_HEADERS, [
    "Сьогодні: Ліди",
    "Сьогодні: Робота",
    "Сьогодні: Апруви",
    "Сьогодні: Відмови",
    "Сьогодні: Апрув %",
    "Оновлено: сьогодні",
  ]);
  assert.equal(MAIN_STATS_HEADERS.some((header) => header.startsWith("Всього:")), false);
  assert.equal(LEGACY_TOTAL_HEADERS.includes("Оновлено: всього"), true);
});

test("a configured workbook can serve status on a cold instance using only reads", async () => {
  const store = new SheetsStore({ mainSheet: "Шур", spreadsheetId: "cold-layout-test" });
  const headers = ["Назва потоку", "Статус", ...MAIN_STATS_HEADERS, "Кінг"];
  const main = { properties: { title: "Шур", sheetId: 1 }, conditionalFormats: [{
    ranges: [{ startRowIndex: 1, endColumnIndex: headers.length }],
    booleanRule: { condition: { values: [{ userEnteredValue: "=$B2=TRUE" }] } },
  }] };
  const tabs = HIDDEN_TECHNICAL_SHEETS.filter(title => title !== "_BOT_UPDATES")
    .map((title, i) => ({ properties: { title, sheetId: i + 2, hidden: true } }));
  let headerReads = 0;
  store.api = { spreadsheets: {
    get: async () => ({ data: { properties: { title: "test" }, sheets: [main, ...tabs] } }),
    values: {
      get: async () => { headerReads++; return { data: { values: [headers] } }; },
      batchGet: async () => ({ data: { valueRanges: [{}] } }),
    },
  } };
  assert.equal((await store.status()).statsColumns, 6);
  assert.equal((await store.status()).headerRow, 1);
  assert.equal(headerReads, 1);
});

test("technical storage sheets stay out of the visible tab bar", () => {
  assert.deepEqual(HIDDEN_TECHNICAL_SHEETS, [
    "СТАТА_ПО_ДНЯМ",
    "СТАТА_ВСЕГО",
    "ЖУРНАЛ",
    "_BOT_PENDING",
    "_BOT_SESSION",
    "_BOT_UPDATES",
  ]);
});
