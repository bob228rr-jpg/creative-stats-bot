import test from "node:test";
import assert from "node:assert/strict";
import { indexKingAccounts, offerForCreative, parseLaunch } from "../lib/launch.js";
import { MAIN_STATS_HEADERS, SheetsStore } from "../lib/sheets.js";
import { kyivSheetDateTime } from "../lib/dates.js";
import { handleIncomingMessage } from "../lib/bot.js";

const headers = ["Чиє крео", "Офер", "Назва крео", "Назва потоку", "Дата запуску", "Статус", "Коментар", "Кінг"];
const id = "990000000000000011";
const kingRows = [["Кинг1","Аккаунти1","назва зацепу","Кинг8","Аккаунти8","назва зацепу"],
  ["9 PRO Hgu Hj","","","AF_85686 Віолетта Струкова Гео"], ["","100000011","", "",id,"ТравСугШурК1"]];
const input = name => parseLaunch(`${name} ${id} example.com`);
test("offer codes, unknowns and exact account IDs", () => {
  for (const [code, offer] of Object.entries({Гем:"Геморой", Пап:"Папилломы", Нет:"Нетримання", Прост:"Простатит", Нейр:"Нейропатия", Суг:"Суглоби", Пох:"Похудалка", Хх:""})) {
    assert.equal(offerForCreative(`А${code}ШурК3`), offer);
  }
  assert.equal(input("ПетрГемШурК3").id, id);
  assert.equal(parseLaunch("example.com 7 2 1 4"), null);
  assert.equal(indexKingAccounts(kingRows).get("100000011")[0].name,"Hgu Hj");
  assert.equal(indexKingAccounts(kingRows).get(id)[0].name,"Віолетта Струкова");
});
test("writes both sheets together, skips unknown offer and preserves existing row on retry", async () => {
  const store = Object.create(SheetsStore.prototype);
  store.config = { mainSheet: "Шур", spreadsheetId:"test" };
  store.ensureSetup = async () => ({ kingSheet:{ title:"Шур King", sheetId:9 }, headerRow:1, headers, mainSheetId:7, mainProperties:{gridProperties:{rowCount:100}} });
  const batch = [], mainRows = [headers, ["","", "ТравСугШурК1",`ТравСугШурК1 ${id} old.example`]];
  store.api = { spreadsheets:{ values:{batchGet:async () => ({data:{valueRanges:[{values:mainRows},{values:kingRows}]}})},
    batchUpdate:async args => batch.push(args.requestBody.requests) } };
  const launch = input("НовШурК3");
  assert.equal((await store.addLaunch(launch)).row, 3);
  const writes = batch[0].flatMap(req => req.updateCells ? [req.updateCells] : []);
  assert.ok(writes.filter(w => w.range.sheetId === 7).every(w => w.range.startRowIndex === 2));
  assert.equal(writes.at(-1).rows[0].values[0].userEnteredValue.stringValue, launch.creative);
  assert.ok(!batch[0].some(req => req.repeatCell?.range.sheetId === 9));
  assert.deepEqual(writes.filter(w => w.range.sheetId === 7).map(w => w.range.startColumnIndex), [2,3,4,5,7]);
  assert.equal(writes.find(w => w.range.sheetId === 7 && w.range.startColumnIndex === 7)
    .rows[0].values[0].userEnteredValue.formulaValue, '=IF($F3,"Віолетта Струкова","")');
  assert.equal(writes.at(-1).range.sheetId,9);
  assert.equal(writes.at(-1).range.startColumnIndex,5);
  mainRows.push(["","",launch.creative,launch.flow]);
  assert.equal((await store.addLaunch(launch)).isNew,false);
  assert.equal(batch.length,2);
  await assert.rejects(store.addLaunch({...launch,id:"00000000"}), /Не нашёл/);
  assert.equal(batch.length,2);
});

test("launch prompt survives requests, handles pasted Unicode and leaves the session on save or cancel", async () => {
  const replies = [], saved = [];
  let session;
  const store = {
    getSession: async () => session,
    setSession: async (_, period) => { session = { period }; },
    addLaunch: async launch => { saved.push(launch); return { isNew: true, row: 4 }; },
  };
  const receive = text => handleIncomingMessage({
    update: { message: { text, chat: { id: 1 }, from: { id: 1 } } },
    telegram: { sendMessage: async (_, reply) => replies.push(reply) }, store,
  });
  await receive("➕ Добавить запуск");
  await receive("ТравНейрШурК2 1234 dunevale.shop");
  assert.match(replies.at(-1), /ID кабинета/);
  assert.equal(session.period, "launch");
  await receive("ТравНейрШурК2".normalize("NFD") + "\u00a0949128094885036\ndune\u200bvale.shop");
  assert.equal(saved[0].flow, "ТравНейрШурК2 949128094885036 dunevale.shop");
  assert.equal(session.period, "");
  await receive("/launch");
  await receive("/cancel");
  assert.equal(session.period, "");
  await receive("ТравНейрШурК2\u200b949128094885036\u200bdunevale.shop");
  assert.equal(saved.length, 2);
});
test("Kyiv sheet serial crosses midnight and respects summer time", () => {
  assert.equal(kyivSheetDateTime("2026-07-14T21:00:00Z"), Date.UTC(2026,6,15)/86400000 + 25569);
  assert.equal(kyivSheetDateTime("2026-11-17T22:00:00Z"), Date.UTC(2026,10,18)/86400000 + 25569);
});

test("new launches style the stats row without inheriting its neighbour's fill", async () => {
  const titles = [...headers.slice(0, -1), ...MAIN_STATS_HEADERS, "Кінг"];
  const firstStat = titles.indexOf(MAIN_STATS_HEADERS[0]);
  for (const mainTable of [undefined, { range: { endRowIndex: 10 } }]) {
    const store = Object.create(SheetsStore.prototype);
    store.config = { mainSheet: "Шур", spreadsheetId: "test" };
    store.ensureSetup = async () => ({ mainSheetId: 7, kingSheet: { title: "Шур King", sheetId: 9 },
      headerRow: 1, headers: titles, mainTable, mainProperties: { gridProperties: { rowCount: 100 } } });
    let requests;
    store.api = { spreadsheets: { values: { batchGet: async () => ({ data: { valueRanges: [
      { values: [titles, ["", "", "Old", "Old 100000011 old.example"]] }, { values: kingRows },
    ] } }) }, batchUpdate: async ({requestBody}) => { requests = requestBody.requests; } } };
    await store.addLaunch(input("НовШурК3"));
    for (const {copyPaste} of requests) {
      if (copyPaste?.pasteType === "PASTE_FORMAT") assert.ok(copyPaste.destination.endColumnIndex <= firstStat);
    }
    const formats = requests.map(r => r.repeatCell).filter(r => r?.range.startColumnIndex >= firstStat);
    assert.equal(formats.length, 7);
    for (const r of formats) {
      assert.equal(r.range.startRowIndex, 2);
      assert.equal(r.cell.userEnteredFormat.textFormat.bold, true);
      assert.equal(r.cell.userEnteredFormat.horizontalAlignment, "CENTER");
      assert.equal(r.cell.userEnteredFormat.borders.top.style, "SOLID");
      assert.doesNotMatch(r.fields, /backgroundColor/);
    }
    assert.equal(formats[4].cell.userEnteredFormat.numberFormat.pattern, "0.0%");
    assert.equal(formats[5].cell.userEnteredFormat.numberFormat.pattern, "hh:mm");
  }
});
