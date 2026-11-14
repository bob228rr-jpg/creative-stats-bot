const KYIV_TZ = "Europe/Kyiv";

function partsAt(date, timeZone = KYIV_TZ) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  return Object.fromEntries(parts.map(({ type, value }) => [type, value]));
}

export function kyivDate(date = new Date()) {
  const { year, month, day } = partsAt(date);
  return `${year}-${month}-${day}`;
}

export function addCalendarDays(isoDate, days) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!match) throw new Error(`Invalid calendar date: ${isoDate}`);
  const value = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + days));
  return value.toISOString().slice(0, 10);
}

export function periodTargetDate(period, now = new Date()) {
  const today = kyivDate(now);
  if (period === "today") return today;
  if (period === "yesterday") return addCalendarDays(today, -1);
  if (period === "total") return null;
  throw new Error(`Unknown period: ${period}`);
}

export function isoNow(now = new Date()) {
  return now.toISOString();
}

export { KYIV_TZ };
