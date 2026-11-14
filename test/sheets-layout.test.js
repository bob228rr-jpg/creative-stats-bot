import assert from "node:assert/strict";
import test from "node:test";
import { HIDDEN_TECHNICAL_SHEETS, LEGACY_TOTAL_HEADERS, MAIN_STATS_HEADERS } from "../lib/sheets.js";

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
