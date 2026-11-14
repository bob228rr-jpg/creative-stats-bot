import assert from "node:assert/strict";
import test from "node:test";
import { approvalRatio, buildDomainIndex, findFlowColumn, matchReport } from "../lib/matching.js";

test("matches a unique domain and reports missing or duplicated rows", () => {
  const headers = ["Назва крео", " Назва   потоку "];
  const flow = findFlowColumn(headers);
  const rows = [
    ["A", "Flow 123 a.example.com"],
    ["B", "Flow 456 b.example.com"],
    ["C", "Restart b.example.com"],
  ];
  const index = buildDomainIndex(rows, flow, 2);
  const entries = ["a.example.com", "b.example.com", "missing.example.com"].map((domain) => ({ domain }));
  const result = matchReport(entries, index);
  assert.equal(result.matched[0].rowNumber, 2);
  assert.deepEqual(result.notFound, ["missing.example.com"]);
  assert.deepEqual(result.duplicates, [{ domain: "b.example.com", rows: [3, 4] }]);
});

test("approval ratio handles zero leads", () => {
  assert.equal(approvalRatio(2, 4), 0.5);
  assert.equal(approvalRatio(0, 0), null);
});
