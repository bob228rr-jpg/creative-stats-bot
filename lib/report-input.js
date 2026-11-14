import { extractDomains, normalizeDomain } from "./domain.js";

const OCR_TLDS = new Set([
  "app",
  "biz",
  "click",
  "cloud",
  "co",
  "com",
  "fun",
  "icu",
  "info",
  "io",
  "live",
  "me",
  "net",
  "online",
  "org",
  "pro",
  "run",
  "shop",
  "site",
  "space",
  "store",
  "top",
  "world",
  "xyz",
]);

function cleanFragment(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9.-]/g, "");
}

function richTextValue(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(richTextValue).join("");
  if (!value || typeof value !== "object") return "";
  if (typeof value.alternative_text === "string") return value.alternative_text;
  if (value.text !== undefined) return richTextValue(value.text);
  if (typeof value.expression === "string") return value.expression;
  return "";
}

function richBlockLines(block) {
  if (!block || typeof block !== "object") return [];
  if (block.type === "table" && Array.isArray(block.cells)) {
    const caption = richTextValue(block.caption).trim();
    const rows = block.cells
      .map((row) => (Array.isArray(row) ? row.map((cell) => richTextValue(cell?.text).trim()).join(" | ") : ""))
      .filter(Boolean);
    return caption ? [caption, ...rows] : rows;
  }

  const ownText = richTextValue(block.text).trim();
  const nestedBlocks = Array.isArray(block.blocks) ? block.blocks.flatMap(richBlockLines) : [];
  const listBlocks = Array.isArray(block.items)
    ? block.items.flatMap((item) => (Array.isArray(item?.blocks) ? item.blocks.flatMap(richBlockLines) : []))
    : [];
  return [...(ownText ? [ownText] : []), ...nestedBlocks, ...listBlocks];
}

export function richMessageText(richMessage) {
  if (!Array.isArray(richMessage?.blocks)) return "";
  return richMessage.blocks.flatMap(richBlockLines).filter(Boolean).join("\n");
}

function standaloneFragment(line) {
  const value = String(line || "").trim();
  if (!/^[a-z0-9.-]{2,}$/i.test(value) || !/[a-z]/i.test(value)) return null;
  return cleanFragment(value);
}

function metricLine(line) {
  const matches = [...String(line || "").matchAll(/\d+/g)];
  if (matches.length < 4) return null;
  const fragment = cleanFragment(String(line).slice(0, matches[0].index));
  if (!fragment || !/[a-z]/.test(fragment)) return null;
  const metrics = matches.slice(0, 4).map((match) => Number(match[0]));
  if (metrics.some((value) => !Number.isSafeInteger(value))) return null;
  return { fragment, metrics };
}

function completeOcrDomain(fragments) {
  const domain = normalizeDomain(fragments.join(""));
  if (!domain || domain.split(".").length < 3) return null;
  return OCR_TLDS.has(domain.split(".").at(-1)) ? domain : null;
}

export function normalizeOcrReportText(text) {
  const rows = [];
  let pending = [];
  let active = null;

  for (const rawLine of String(text || "").split(/\r?\n/)) {
    const metrics = metricLine(rawLine);
    if (metrics) {
      active = { fragments: [...pending, metrics.fragment], metrics: metrics.metrics };
      pending = [];
      const domain = completeOcrDomain(active.fragments);
      if (domain) {
        rows.push(`${domain} ${active.metrics.join(" ")}`);
        active = null;
      }
      continue;
    }

    const fragment = standaloneFragment(rawLine);
    if (!fragment) continue;
    if (active) {
      active.fragments.push(fragment);
      const domain = completeOcrDomain(active.fragments);
      if (domain) {
        rows.push(`${domain} ${active.metrics.join(" ")}`);
        active = null;
      }
    } else {
      pending.push(fragment);
      if (pending.length > 3) pending.shift();
    }
  }

  return rows.join("\n");
}

export function reportContent(message) {
  if (message?.text?.trim()) return { text: message.text, entities: message.entities || [], source: "text" };
  if (message?.caption?.trim()) {
    return { text: message.caption, entities: message.caption_entities || [], source: "caption" };
  }
  const richText = richMessageText(message?.rich_message);
  if (richText) return { text: richText, entities: [], source: "rich" };
  return null;
}

export function reportImageFileId(message) {
  if (Array.isArray(message?.photo) && message.photo.length) return message.photo.at(-1)?.file_id || null;
  if (message?.document?.file_id && /^image\//i.test(message.document.mime_type || "")) {
    return message.document.file_id;
  }
  return null;
}

export function shouldRecognizeImage(report) {
  return !report || (report.source === "caption" && extractDomains(report.text).length === 0);
}

export async function recognizeReportImage(bytes) {
  const { createWorker } = await import("tesseract.js");
  const worker = await createWorker("eng", undefined, {
    langPath: process.cwd(),
    gzip: false,
    cacheMethod: "none",
  });
  try {
    const result = await worker.recognize(Buffer.from(bytes));
    return normalizeOcrReportText(result.data.text);
  } finally {
    await worker.terminate();
  }
}
