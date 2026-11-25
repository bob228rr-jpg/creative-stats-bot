import assert from "node:assert/strict";
import test from "node:test";
import { handleIncomingMessage } from "../lib/bot.js";
import { MAIN_STATS_HEADERS, SheetsStore } from "../lib/sheets.js";

function workbook() {
  const store = Object.create(SheetsStore.prototype);
  store.config = { mainSheet: "Шур", spreadsheetId: "test" };
  const layout = { mainSheetId: 1, technical: { "СТАТА_ПО_ДНЯМ": 2, "ЖУРНАЛ": 3, "_BOT_PENDING": 4 } };
  store.ensureSetup = async () => layout;
  const rows = [["Назва потоку", ...MAIN_STATS_HEADERS],
    ["B 222222 other.shop", 9], ["A 111111 example.com"]];
  const requests = [], replies = [], reads = [];
  const receipts = [];
  let version;
  const faults = { beforeCommit: false, afterCommit: false, sending: false };
  store.api = { spreadsheets: {
    get: async () => ({ data: { namedRanges: version ? [version] : [] } }),
    values: {
      get: async () => ({ data: {} }), // No active launch session.
      batchGet: async ({ ranges }) => {
        reads.push(ranges);
        return { data: { valueRanges: [{ values: rows }, { values: [] }, { values: receipts.slice() }] } };
      },
    },
    batchUpdate: async ({ requestBody }) => {
      if (faults.beforeCommit) throw Error("sheet unavailable");
      const batch = requestBody.requests;
      if (version && !batch.some(req => req.deleteNamedRange?.namedRangeId === version.namedRangeId)) throw Error("version changed");
      version = { ...batch.find(req => req.addNamedRange).addNamedRange.namedRange, namedRangeId: String(requests.length + 1) };
      const journalRows = batch.find(req => req.appendCells?.sheetId === 3).appendCells.rows;
      for (const row of journalRows) receipts.push([row.values[14].userEnteredValue.stringValue]);
      requests.push(batch);
      if (faults.afterCommit) throw Error("response lost");
    },
  } };
  const receive = (text = "example.com 7 2 1 4", updateId = 101) => handleIncomingMessage({
    store, update: { update_id: updateId, message: { chat: { id: 1 }, from: { id: 1 }, text } },
    telegram: { sendMessage: async (_, reply) => {
      if (faults.sending) throw Error("telegram unavailable");
      replies.push(reply);
    } },
  });
  return { store, receive, requests, reads, replies, faults, rows };
}

test("a lost Telegram reply is recovered without rewriting the report", async () => {
  const { receive, requests, replies, faults } = workbook();
  faults.sending = true;
  await assert.rejects(receive(), /telegram unavailable/);
  faults.sending = false;
  await receive();
  assert.equal(requests.length, 1);
  assert.match(replies[0], /внесена. Доменов: 1/);
});

test("redelivery retries a failed write and recognizes a commit with a lost response", async () => {
  const { receive, requests, reads, replies, faults } = workbook();
  faults.beforeCommit = true;
  await assert.rejects(receive(), /sheet unavailable/);
  assert.equal(requests.length, 0);
  faults.beforeCommit = false;
  faults.afterCommit = true;
  await assert.rejects(receive(), /response lost/);
  faults.afterCommit = false;
  await receive();
  assert.equal(requests.length, 1);
  assert.equal(replies.length, 1);
  assert.deepEqual(reads[0], ["'Шур'", "'СТАТА_ПО_ДНЯМ'!A2:G", "'ЖУРНАЛ'!O2:O"]);
});

test("matches the current domain row and preserves columns inserted between metrics", async () => {
  const { receive, requests, rows, replies } = workbook();
  rows[0].splice(2, 0, "Коментар");
  await receive();
  const batch = requests[0];
  const mainWrites = batch.map(req => req.updateCells ?? req.repeatCell).filter(req => req?.range.sheetId === 1);
  assert.ok(mainWrites.length);
  for (const {range, rows: written} of mainWrites) {
    assert.ok(range.endColumnIndex <= 2 || range.startColumnIndex > 2);
    if (written) assert.equal(range.startRowIndex, 2);
  }
  rows.push(["C 333333 example.com"]);
  await receive(undefined, 102);
  assert.equal(requests.length, 1);
  assert.match(replies.at(-1), /дубль/);
  await receive("absent.shop 1 1 0 0", 103);
  assert.equal(requests.length, 1);
  assert.match(replies.at(-1), /отсутствует/);
});

test("overlapping reports retry from a fresh workbook version", async () => {
  const { receive, requests } = workbook();
  const results = await Promise.allSettled([receive(), receive()]);
  assert.equal(requests.length, 1);
  if (results.some(r => r.status === "rejected")) await receive();
  assert.equal(requests.length, 1);
  await receive(undefined, 102);
  assert.ok(requests[1].some(req => req.deleteNamedRange?.namedRangeId === "1"));
});
