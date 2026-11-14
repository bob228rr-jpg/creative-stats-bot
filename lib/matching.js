import { extractDomains } from "./domain.js";

export function normalizeHeader(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

const FLOW_HEADERS = ["назва потоку", "название потока", "поток", "flow", "flow name"];

export function findFlowColumn(headers) {
  const normalized = headers.map(normalizeHeader);
  const index = normalized.findIndex((header) => FLOW_HEADERS.includes(header));
  if (index < 0) throw new Error("Не найдена колонка «Назва потоку» в основной таблице.");
  return index;
}

export function buildDomainIndex(rows, flowColumnIndex, firstDataRow) {
  const index = new Map();
  for (let offset = 0; offset < rows.length; offset += 1) {
    const rowNumber = firstDataRow + offset;
    for (const domain of extractDomains(rows[offset]?.[flowColumnIndex] || "")) {
      const existing = index.get(domain) || [];
      existing.push(rowNumber);
      index.set(domain, existing);
    }
  }
  return index;
}

export function matchReport(entries, domainIndex) {
  const matched = [];
  const notFound = [];
  const duplicates = [];
  for (const entry of entries) {
    const rows = domainIndex.get(entry.domain) || [];
    if (rows.length === 1) matched.push({ ...entry, rowNumber: rows[0] });
    else if (rows.length === 0) notFound.push(entry.domain);
    else duplicates.push({ domain: entry.domain, rows });
  }
  return { matched, notFound, duplicates };
}

export function approvalRatio(approved, leads) {
  return leads > 0 ? approved / leads : null;
}
