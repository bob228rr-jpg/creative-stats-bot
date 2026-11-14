import assert from "node:assert/strict";
import test from "node:test";
import { addCalendarDays, kyivDate, periodTargetDate } from "../lib/dates.js";

test("Kyiv date follows local midnight", () => {
  assert.equal(kyivDate(new Date("2026-03-28T22:30:00.000Z")), "2026-03-29");
});

test("yesterday uses calendar arithmetic across spring DST", () => {
  const now = new Date("2026-03-29T22:30:00.000Z");
  assert.equal(periodTargetDate("today", now), "2026-03-30");
  assert.equal(periodTargetDate("yesterday", now), "2026-03-29");
});

test("calendar arithmetic crosses month and year boundaries", () => {
  assert.equal(addCalendarDays("2026-01-01", -1), "2025-12-31");
});
