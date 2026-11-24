import { normalizeDomain } from "./domain.js";

const offers = new Map(Object.entries({
  гем: "Геморой", пап: "Папилломы", нет: "Нетримання", прост: "Простатит",
  нейр: "Нейропатия", суг: "Суглоби", пох: "Похудалка",
}));

export function offerForCreative(creative) {
  const stem = creative.split(/шур/iu)[0].toLowerCase();
  return [...offers].find(([code]) => stem.endsWith(code))?.[1] || "";
}

export function parseLaunch(text) {
  const normalized = text.normalize("NFC").replace(/[\u200e\u200f\u2060\ufeff]/gu, "");
  const pattern = /^([\p{L}\p{N}_-]+)\s+(\d{6,24})\s+(\S+)$/u;
  const match = pattern.exec(normalized.replaceAll("\u200b", "").trim())
    || pattern.exec(normalized.replaceAll("\u200b", " ").trim());
  if (!match) return null;
  const [, creative, id, rawDomain] = match;
  const domain = normalizeDomain(rawDomain);
  if (!domain) return null;
  return { creative, id, domain, flow: `${creative} ${id} ${domain}`, offer: offerForCreative(creative) };
}

export function kingName(label) {
  return String(label || "").trim().replace(/\s+/gu, " ")
    .replace(/^(?:AF[_ -]*\d+|\d+\s+PRO)\s+/iu, "")
    .replace(/\s+гео$/iu, "").trim();
}

// Each repeated horizontal group has its own king label above the account rows.
export function kingAccountHeader(row, col) {
  return /^к[иі]нг\s*\d*$/iu.test(String(row[col]).trim()) &&
    /^ак+аунт[иы]?\s*\d*$/iu.test(String(row[col + 1]).trim()) &&
    /^назва\s+зацепу/iu.test(String(row[col + 2]).trim());
}

export function indexKingAccounts(rows) {
  const groups = new Map();
  const accounts = new Map();
  rows.forEach((row, rowIndex) => {
    for (let col = 0; col < row.length; col++) {
      if (kingAccountHeader(row, col)) {
        groups.set(col, "");
      }
    }
    for (const [col] of groups) {
      const label = String(row[col] ?? "").trim();
      if (/^к[иі]нг\s*\d*$/iu.test(label)) continue;
      if (label) groups.set(col, kingName(label));
      const id = String(row[col + 1] ?? "").trim();
      if (!/^\d{6,24}$/.test(id)) continue;
      const matches = accounts.get(id) || [];
      matches.push({ rowIndex, columnIndex: col + 1, name: groups.get(col) });
      accounts.set(id, matches);
    }
  });
  return accounts;
}

export class LaunchConflict extends Error {}
