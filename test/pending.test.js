import assert from "node:assert/strict";
import test from "node:test";
import { claimPendingRecord, completePendingRecord } from "../lib/pending.js";

test("double save can claim only before completion", () => {
  const initial = { status: "PENDING" };
  const first = claimPendingRecord(initial, "claim-a", "2026-11-14T00:00:00.000Z");
  assert.equal(first.claimed, true);
  const done = completePendingRecord(first.record, "2026-11-14T00:00:01.000Z");
  const second = claimPendingRecord(done, "claim-b", "2026-11-14T00:00:02.000Z");
  assert.equal(second.claimed, false);
  assert.equal(second.record.status, "DONE");
});

test("errored snapshot can be retried safely", () => {
  const retry = claimPendingRecord({ status: "ERROR" }, "claim-retry", "2026-11-14T00:00:00.000Z");
  assert.equal(retry.claimed, true);
  assert.equal(retry.record.status, "PROCESSING");
});
