import { extractDomains, normalizeDomain } from "./domain.js";

const FIELD_ALIASES = {
  domain: ["домен", "domain", "сайт", "url"],
  leads: ["лиды", "ліди", "лид", "лід", "leads", "lead"],
  work: ["работа", "робота", "в работе", "у роботі", "work", "processing"],
  approved: ["апрувы", "апруви", "апрув", "approve", "approved"],
  rejected: ["отказы", "відмови", "отказ", "відмова", "reject", "rejected"],
};

const PERIOD_PREFIXES = new Map([
  ["today", "today"],
  ["сегодня", "today"],
  ["сьогодні", "today"],
  ["yesterday", "yesterday"],
  ["вчера", "yesterday"],
  ["вчора", "yesterday"],
  ["total", "total"],
  ["всего", "total"],
  ["всього", "total"],
  ["all time", "total"],
]);

function normalizeLabel(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[*_`:#|()[\]{}.,;!?%]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function aliasField(value) {
  const label = normalizeLabel(value);
  for (const [field, aliases] of Object.entries(FIELD_ALIASES)) {
    if (aliases.some((alias) => label === alias || label.includes(alias))) return field;
  }
  return null;
}

function splitCells(line) {
  if (line.includes("|")) {
    return line
      .split("|")
      .map((cell) => cell.trim())
      .filter((cell, index, all) => cell || (index > 0 && index < all.length - 1));
  }
  if (/\t|\s{2,}/.test(line)) return line.trim().split(/\t+|\s{2,}/).map((cell) => cell.trim());
  return null;
}

function parseInteger(value) {
  const clean = String(value ?? "").trim().replace(/[.,;:]+$/, "");
  if (!/^\d+$/.test(clean)) return null;
  const number = Number(clean);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function rowFromValues(domain, values, line, options) {
  if (!domain || values.some((value) => value === null)) {
    return { error: { line, reason: "invalid_values" } };
  }
  const [leads, work, approved, rejected] = values;
  if (options.strictStatusSum && work + approved + rejected > leads) {
    return { error: { line, domain, reason: "status_sum_exceeds_leads" } };
  }
  const warnings = [];
  if (work + approved + rejected > leads) warnings.push("status_sum_exceeds_leads");
  return { entry: { domain, leads, work, approved, rejected, sourceLine: line, warnings } };
}

function entityDomainsByLine(text, entities = []) {
  const lineStarts = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "\n") lineStarts.push(index + 1);
  }
  const result = new Map();
  for (const entity of entities) {
    if (!["text_link", "url"].includes(entity?.type)) continue;
    const raw = entity.type === "text_link" ? entity.url : text.slice(entity.offset, entity.offset + entity.length);
    const domain = normalizeDomain(raw);
    if (!domain) continue;
    let lineIndex = 0;
    while (lineIndex + 1 < lineStarts.length && lineStarts[lineIndex + 1] <= entity.offset) lineIndex += 1;
    const existing = result.get(lineIndex) || [];
    if (!existing.includes(domain)) existing.push(domain);
    result.set(lineIndex, existing);
  }
  return result;
}

function findHeader(lines) {
  for (let index = 0; index < Math.min(lines.length, 20); index += 1) {
    const cells = splitCells(lines[index]);
    if (!cells) continue;
    const fields = cells.map(aliasField);
    const required = ["domain", "leads", "work", "approved", "rejected"];
    if (required.every((field) => fields.includes(field))) {
      return { lineIndex: index, fields };
    }
  }
  return null;
}

function parseTableRows(lines, header, options, entityDomains) {
  const entries = [];
  const errors = [];
  const consumed = new Set([header.lineIndex]);
  for (let index = header.lineIndex + 1; index < lines.length; index += 1) {
    const cells = splitCells(lines[index]);
    if (!cells || cells.every((cell) => /^:?-{2,}:?$/.test(cell))) continue;
    const value = {};
    for (let cellIndex = 0; cellIndex < header.fields.length; cellIndex += 1) {
      const field = header.fields[cellIndex];
      if (field) value[field] = cells[cellIndex];
    }
    const domain = normalizeDomain(value.domain) || extractDomains(value.domain || "")[0] || entityDomains.get(index)?.[0];
    if (!domain) continue;
    consumed.add(index);
    const parsed = rowFromValues(
      domain,
      [value.leads, value.work, value.approved, value.rejected].map(parseInteger),
      index + 1,
      options,
    );
    if (parsed.entry) entries.push(parsed.entry);
    else errors.push(parsed.error);
  }
  return { entries, errors, consumed };
}

function labeledMetricsFromBlock(lines, start, end) {
  const values = {};
  for (let index = start; index < end; index += 1) {
    const match = lines[index].match(/^\s*([^:–—-]+?)\s*[:–—-]\s*(\d+)\s*$/);
    if (!match) continue;
    const field = aliasField(match[1]);
    if (field && field !== "domain") values[field] = parseInteger(match[2]);
  }
  return values;
}

function deduplicate(entries, errors) {
  const counts = new Map();
  for (const entry of entries) counts.set(entry.domain, (counts.get(entry.domain) || 0) + 1);
  const duplicateDomains = [...counts.entries()].filter(([, count]) => count > 1).map(([domain]) => domain);
  for (const domain of duplicateDomains) errors.push({ domain, reason: "duplicate_domain_in_report" });
  return {
    entries: entries.filter((entry) => counts.get(entry.domain) === 1),
    duplicateDomains,
  };
}

export function extractPeriodPrefix(text) {
  const normalized = String(text || "").replace(/\r/g, "");
  const lines = normalized.split("\n");
  const firstNonEmpty = lines.findIndex((line) => line.trim());
  if (firstNonEmpty < 0) return { period: null, text: "" };
  const clean = normalizeLabel(lines[firstNonEmpty]).replace(/^\//, "");
  const period = PERIOD_PREFIXES.get(clean) || null;
  if (!period) return { period: null, text: lines.join("\n") };
  const start = lines.slice(0, firstNonEmpty).reduce((total, line) => total + line.length + 1, 0);
  const end = start + lines[firstNonEmpty].length + (firstNonEmpty < lines.length - 1 ? 1 : 0);
  lines.splice(firstNonEmpty, 1);
  const result = { period, text: lines.join("\n") };
  Object.defineProperty(result, "removedRange", { value: { start, end }, enumerable: false });
  return result;
}

export function parseReport(text, entities = [], options = {}) {
  const source = String(text || "").replace(/\r/g, "");
  const lines = source.split("\n");
  const entityDomains = entityDomainsByLine(source, entities);
  const parsedOptions = { strictStatusSum: Boolean(options.strictStatusSum) };
  const entries = [];
  const errors = [];
  const consumed = new Set();

  const header = findHeader(lines);
  if (header) {
    const table = parseTableRows(lines, header, parsedOptions, entityDomains);
    entries.push(...table.entries);
    errors.push(...table.errors);
    for (const line of table.consumed) consumed.add(line);
  }

  for (let index = 0; index < lines.length; index += 1) {
    if (consumed.has(index)) continue;
    const visibleDomains = extractDomains(lines[index]);
    const domains = [...new Set([...visibleDomains, ...(entityDomains.get(index) || [])])];
    if (!domains.length) continue;
    if (domains.length > 1) {
      errors.push({ line: index + 1, reason: "multiple_domains_on_line" });
      continue;
    }
    const domain = domains[0];
    const withoutDomain = lines[index].replace(/(?:https?:\/\/)?(?:www\.)?[a-z0-9.-]+\.[a-z]{2,63}(?:[/?#][^\s|]*)?/gi, " ");
    const numbers = [...withoutDomain.matchAll(/(?<![\d.,])\d+(?![\d.,%])/g)].map((match) => parseInteger(match[0]));
    if (numbers.length === 4) {
      const parsed = rowFromValues(domain, numbers, index + 1, parsedOptions);
      if (parsed.entry) entries.push(parsed.entry);
      else errors.push(parsed.error);
      consumed.add(index);
      continue;
    }
    if (numbers.length > 4) {
      errors.push({ line: index + 1, domain, reason: "ambiguous_numeric_columns" });
      continue;
    }

    let nextDomainLine = lines.length;
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      if (extractDomains(lines[cursor]).length || entityDomains.get(cursor)?.length) {
        nextDomainLine = cursor;
        break;
      }
    }
    const labeled = labeledMetricsFromBlock(lines, index + 1, nextDomainLine);
    if (["leads", "work", "approved", "rejected"].every((field) => Number.isInteger(labeled[field]))) {
      const parsed = rowFromValues(
        domain,
        [labeled.leads, labeled.work, labeled.approved, labeled.rejected],
        index + 1,
        parsedOptions,
      );
      if (parsed.entry) entries.push(parsed.entry);
      else errors.push(parsed.error);
      for (let cursor = index; cursor < nextDomainLine; cursor += 1) consumed.add(cursor);
      continue;
    }

    const nextLine = lines[index + 1] || "";
    const nextNumbers = [...nextLine.matchAll(/(?<![\d.,])\d+(?![\d.,%])/g)].map((match) => parseInteger(match[0]));
    if (nextNumbers.length === 4 && !extractDomains(nextLine).length) {
      const parsed = rowFromValues(domain, nextNumbers, index + 1, parsedOptions);
      if (parsed.entry) entries.push(parsed.entry);
      else errors.push(parsed.error);
      consumed.add(index);
      consumed.add(index + 1);
      index += 1;
      continue;
    }
    errors.push({ line: index + 1, domain, reason: "expected_four_metrics" });
  }

  const unique = deduplicate(entries, errors);
  return {
    entries: unique.entries,
    errors,
    duplicateDomains: unique.duplicateDomains,
    warnings: unique.entries.flatMap((entry) => entry.warnings.map((reason) => ({ domain: entry.domain, reason }))),
  };
}
