import assert from "node:assert/strict";
import test from "node:test";
import { extractPeriodPrefix, parseReport } from "../lib/parser.js";

test("parses simple domain plus four metrics", () => {
  const result = parseReport("reamand.ivymarket.space 7 2 1 4\nbl-ia.example.com 3 2 1 0");
  assert.deepEqual(
    result.entries.map(({ domain, leads, work, approved, rejected }) => ({ domain, leads, work, approved, rejected })),
    [
      { domain: "reamand.ivymarket.space", leads: 7, work: 2, approved: 1, rejected: 4 },
      { domain: "bl-ia.example.com", leads: 3, work: 2, approved: 1, rejected: 0 },
    ],
  );
});

test("parses markdown table by localized headers and ignores extra columns", () => {
  const text = [
    "| Домен | Ліди | Робота | Апруви | Відмови | CR |",
    "|---|---:|---:|---:|---:|---:|",
    "| a.example.com | 10 | 2 | 3 | 5 | 30% |",
  ].join("\n");
  const result = parseReport(text);
  assert.equal(result.entries.length, 1);
  assert.deepEqual(result.entries[0], {
    domain: "a.example.com",
    leads: 10,
    work: 2,
    approved: 3,
    rejected: 5,
    sourceLine: 3,
    warnings: [],
  });
});

test("parses Telegram stats with trash and percent columns", () => {
  const text = [
    "📊 Моя статистика",
    "",
    "📅 14.11.26",
    "",
    "Домен Лиды Работа Апрув Отказ Треш %",
    "",
    "blia.ashmoss.world 4 2 1 0 0 25.0",
    "",
    "croumcast.hazelharbor.shop 8 2 1 2 3 12.5",
    "",
    "crythia.glenorbit.space 14 2 3 7 2 21.4",
    "",
    "eanour.deerhollow\\.shop 4 1 1 1 1 25.0",
    "",
    "prucryl.berrygrove.shop 1 1 0 0 0 0.0",
    "",
    "reamand.ivymarket.space 8 2 1 5 0 12.5",
    "",
    "Итого 39 10 7 15 6 17.9",
  ].join("\n");

  const result = parseReport(text);

  assert.equal(result.errors.length, 0);
  assert.deepEqual(
    result.entries.map(({ domain, leads, work, approved, rejected }) => ({ domain, leads, work, approved, rejected })),
    [
      { domain: "blia.ashmoss.world", leads: 4, work: 2, approved: 1, rejected: 0 },
      { domain: "croumcast.hazelharbor.shop", leads: 8, work: 2, approved: 1, rejected: 2 },
      { domain: "crythia.glenorbit.space", leads: 14, work: 2, approved: 3, rejected: 7 },
      { domain: "eanour.deerhollow.shop", leads: 4, work: 1, approved: 1, rejected: 1 },
      { domain: "prucryl.berrygrove.shop", leads: 1, work: 1, approved: 0, rejected: 0 },
      { domain: "reamand.ivymarket.space", leads: 8, work: 2, approved: 1, rejected: 5 },
    ],
  );
});

test("parses domain and metrics on separate lines", () => {
  const result = parseReport("a.example.com\n10 2 3 5");
  assert.equal(result.entries[0].approved, 3);
});

test("parses labeled multiline block", () => {
  const result = parseReport("a.example.com\nЛіди: 8\nРобота: 1\nАпруви: 2\nВідмови: 5");
  assert.deepEqual(
    result.entries.map(({ leads, work, approved, rejected }) => ({ leads, work, approved, rejected })),
    [{ leads: 8, work: 1, approved: 2, rejected: 5 }],
  );
});

test("uses Telegram text_link entity when domain is hidden", () => {
  const text = "Creative A 7 2 1 4";
  const result = parseReport(text, [{ type: "text_link", offset: 0, length: 10, url: "https://hidden.example.com/path" }]);
  assert.equal(result.entries[0].domain, "hidden.example.com");
});

test("removes all duplicate report rows instead of guessing", () => {
  const result = parseReport("a.example.com 7 2 1 4\na.example.com 8 2 2 4");
  assert.equal(result.entries.length, 0);
  assert.deepEqual(result.duplicateDomains, ["a.example.com"]);
  assert.equal(result.errors.at(-1).reason, "duplicate_domain_in_report");
});

test("strict status sum rejects invalid business model", () => {
  const result = parseReport("a.example.com 2 2 1 1", [], { strictStatusSum: true });
  assert.equal(result.entries.length, 0);
  assert.equal(result.errors[0].reason, "status_sum_exceeds_leads");
});

test("non-strict status sum preserves row with warning", () => {
  const result = parseReport("a.example.com 2 2 1 1");
  assert.equal(result.entries.length, 1);
  assert.equal(result.warnings[0].reason, "status_sum_exceeds_leads");
});

test("extracts optional period prefix", () => {
  assert.deepEqual(extractPeriodPrefix("today\na.example.com 1 0 1 0"), {
    period: "today",
    text: "a.example.com 1 0 1 0",
  });
});
