import assert from "node:assert/strict";
import test from "node:test";
import { snapshotReplacementPlan } from "../lib/sheets.js";

const layout = {
  headerRow: 1,
  statsIndexes: {
    "Сьогодні: Ліди": 9,
    "Сьогодні: Робота": 10,
    "Сьогодні: Апруви": 11,
    "Сьогодні: Відмови": 12,
    "Сьогодні: Апрув %": 13,
    "Оновлено: сьогодні": 14,
  },
};

test("today snapshot clears stale main stats and replaces the same daily date", () => {
  const mainRows = [
    [,,,,,,,,,108, 0, 24, 56, 0.222, "old"],
    [,,,,,,,,,8, 2, 1, 5, 0.125, "new"],
    [,,,,,,,,,,,,,,],
  ];
  const plan = snapshotReplacementPlan({
    period: "today",
    targetDate: "2026-11-14",
    matched: [{ rowNumber: 3 }],
    mainRows,
    dailyRows: [
      ["2026-11-13", "old.example", 1, 0, 0, 1],
      ["2026-11-14", "stale.example", 108, 0, 24, 56],
      ["2026-11-14", "reamand.ivymarket.space", 8, 2, 1, 5],
    ],
    totalRows: [["ignored.example", 1, 0, 0, 1]],
    layout,
  });

  assert.equal(plan.clearMain, true);
  assert.equal(plan.clearedMainCount, 1);
  assert.deepEqual(plan.dailyRowIndexes, [2, 3]);
  assert.deepEqual(plan.totalRowIndexes, []);
});

test("total snapshot replaces every previous total row without touching main today columns", () => {
  const plan = snapshotReplacementPlan({
    period: "total",
    targetDate: null,
    matched: [{ rowNumber: 2 }],
    mainRows: [[,,,,,,,,,4, 2, 1, 0, 0.25, "today"]],
    dailyRows: [["2026-11-14", "today.example", 4, 2, 1, 0]],
    totalRows: [["old.example", 10, 2, 3, 5], [], ["current.example", 4, 2, 1, 0]],
    layout,
  });

  assert.equal(plan.clearMain, false);
  assert.equal(plan.clearedMainCount, 0);
  assert.deepEqual(plan.dailyRowIndexes, []);
  assert.deepEqual(plan.totalRowIndexes, [1, 3]);
});
