import test from "node:test";
import assert from "node:assert/strict";
import { indexKingAccounts, offerForCreative, parseLaunch } from "../lib/launch.js";
import { SheetsStore } from "../lib/sheets.js";
import { kyivSheetDateTime } from "../lib/dates.js";

const headers = ["Чиє крео", "Офер", "Назва крео", "Назва потоку", "Дата запуску", "Статус", "Коментар", "Кінг"];
const id = "990000000000000011";
const kingRows = [["Кинг1","Аккаунти1","назва зацепу","Кинг8","Аккаунти8","назва зацепу"],
  ["9 PRO Hgu Hj","","","AF_85686 Віолетта Струкова Гео"], ["","100000011","", "",id]];
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
  const batch = [], mainRows = [headers, ["","", "Старый","Старый 111111 old.example"]];
  store.api = { spreadsheets:{ values:{batchGet:async () => ({data:{valueRanges:[{values:mainRows},{values:kingRows}]}})},
    batchUpdate:async args => batch.push(args.requestBody.requests) } };
  const launch = input("НовШурК3");
  assert.equal((await store.addLaunch(launch)).row, 3);
  const writes = batch[0].flatMap(req => req.updateCells ? [req.updateCells] : []);
  assert.deepEqual(writes.filter(w => w.range.sheetId === 7).map(w => w.range.startColumnIndex), [2,3,4,5,7]);
  assert.equal(writes.at(-1).range.sheetId,9);
  assert.equal(writes.at(-1).range.startColumnIndex,5);
  mainRows.push(["","",launch.creative,launch.flow]);
  assert.equal((await store.addLaunch(launch)).isNew,false);
  assert.equal(batch.length,2);
  await assert.rejects(store.addLaunch({...launch,id:"00000000"}), /Не нашёл/);
  assert.equal(batch.length,2);
});
test("Kyiv sheet serial crosses midnight and respects summer time", () => {
  assert.equal(kyivSheetDateTime("2026-07-14T21:00:00Z"), Date.UTC(2026,6,15)/86400000 + 25569);
  assert.equal(kyivSheetDateTime("2026-11-17T22:00:00Z"), Date.UTC(2026,10,18)/86400000 + 25569);
});
