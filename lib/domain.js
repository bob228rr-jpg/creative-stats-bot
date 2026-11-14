const DOMAIN_RE = /(?<![\p{L}\p{N}-])(?:https?:\/\/)?(?:www\.)?((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63})(?::\d{1,5})?(?:[/?#][^\s|<>()]*)?/giu;

export function normalizeDomain(input) {
  if (typeof input !== "string") return null;
  let value = input.trim().toLowerCase();
  value = value.replace(/^[`'"(<\[{]+|[`'">)\]}.,;:!?]+$/g, "");
  if (!value) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) value = `https://${value}`;
  try {
    const url = new URL(value);
    let host = url.hostname.toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
    if (!host.includes(".") || host.length > 253) return null;
    const labels = host.split(".");
    if (
      labels.some(
        (label) =>
          !label ||
          label.length > 63 ||
          !/^[a-z0-9-]+$/.test(label) ||
          label.startsWith("-") ||
          label.endsWith("-"),
      )
    ) {
      return null;
    }
    if (!/^[a-z]{2,63}$/.test(labels.at(-1))) return null;
    return host;
  } catch {
    return null;
  }
}

export function extractDomains(input) {
  if (typeof input !== "string") return [];
  const found = [];
  for (const match of input.matchAll(DOMAIN_RE)) {
    const domain = normalizeDomain(match[0]);
    if (domain && !found.includes(domain)) found.push(domain);
  }
  return found;
}

export { DOMAIN_RE };
