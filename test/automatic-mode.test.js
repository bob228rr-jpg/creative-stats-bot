import test from "node:test";
import assert from "node:assert/strict";

import { automaticReportProblems } from "../lib/bot.js";

test("automatic mode accepts a completely safe matched report", () => {
  const problems = automaticReportProblems(
    { errors: [] },
    { notFound: [], duplicates: [] },
  );

  assert.deepEqual(problems, []);
});

test("automatic mode blocks the whole write on parse, missing-domain, or duplicate errors", () => {
  const problems = automaticReportProblems(
    { errors: [{ line: 4, reason: "expected_four_metrics" }] },
    {
      notFound: ["missing.example"],
      duplicates: [{ domain: "duplicate.example", rows: [3, 8] }],
    },
  );

  assert.deepEqual(problems, [
    "строка 4: не найдены четыре показателя",
    "missing.example: домен отсутствует в листе «Шур»",
    "duplicate.example: дубль в строках 3, 8",
  ]);
});
