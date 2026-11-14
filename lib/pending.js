export const PENDING_STATUSES = Object.freeze({
  PENDING: "PENDING",
  PROCESSING: "PROCESSING",
  DONE: "DONE",
  CANCELLED: "CANCELLED",
  ERROR: "ERROR",
});

export function canClaimPending(status) {
  return status === PENDING_STATUSES.PENDING || status === PENDING_STATUSES.ERROR;
}

export function claimPendingRecord(record, claimToken, nowIso) {
  if (!canClaimPending(record.status)) return { claimed: false, record };
  return {
    claimed: true,
    record: {
      ...record,
      status: PENDING_STATUSES.PROCESSING,
      claimToken,
      updatedAt: nowIso,
      error: "",
    },
  };
}

export function completePendingRecord(record, nowIso) {
  if (record.status === PENDING_STATUSES.DONE) return record;
  return { ...record, status: PENDING_STATUSES.DONE, updatedAt: nowIso, error: "" };
}
