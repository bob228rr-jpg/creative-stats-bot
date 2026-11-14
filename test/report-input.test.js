import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeOcrReportText,
  reportContent,
  reportImageFileId,
  shouldRecognizeImage,
} from "../lib/report-input.js";

test("uses a forwarded media caption as report text", () => {
  assert.deepEqual(
    reportContent({ caption: "a.example.com 1 0 1 0", caption_entities: [{ type: "bold", offset: 0, length: 1 }] }),
    {
      text: "a.example.com 1 0 1 0",
      entities: [{ type: "bold", offset: 0, length: 1 }],
      source: "caption",
    },
  );
});

test("selects the largest forwarded Telegram photo", () => {
  assert.equal(reportImageFileId({ photo: [{ file_id: "small" }, { file_id: "large" }] }), "large");
  assert.equal(reportImageFileId({ document: { file_id: "image", mime_type: "image/png" } }), "image");
});

test("uses OCR when an image caption has no report rows", () => {
  assert.equal(shouldRecognizeImage(null), true);
  assert.equal(shouldRecognizeImage({ source: "caption", text: "📊 Моя статистика" }), true);
  assert.equal(shouldRecognizeImage({ source: "caption", text: "a.example.com 1 0 1 0" }), false);
});

test("reassembles wrapped OCR domains and keeps the first four metrics", () => {
  const ocr = [
    "OomeH Niuppl Pa6ora AnpyB Otkas T",
    "blia.ashm 4 2 1 0",
    "oss.world",
    "croumcas",
    "t.hazelhar 8 2 1 2",
    "bor.shop",
    "crythia.gle",
    "norbit.spa 14 2 3 7",
    "ce",
    "eanour.de",
    "erhollow.s 4 1 1 1",
    "hop",
    "prucryl.be",
    "rrygrove.s 1 1 0 0",
    "hop",
    "reamand.i",
    "vymarket. 8 2 1 5",
    "space",
    "WToro 39 10 7 15",
  ].join("\n");

  assert.equal(
    normalizeOcrReportText(ocr),
    [
      "blia.ashmoss.world 4 2 1 0",
      "croumcast.hazelharbor.shop 8 2 1 2",
      "crythia.glenorbit.space 14 2 3 7",
      "eanour.deerhollow.shop 4 1 1 1",
      "prucryl.berrygrove.shop 1 1 0 0",
      "reamand.ivymarket.space 8 2 1 5",
    ].join("\n"),
  );
});
