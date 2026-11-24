/** Conservative parser for a single clearly stated product price. */
const PRICE_TOKEN = /(?<!\d)(?:\d{1,3}(?:[ \u00a0\u202f.,]\d{3})+|\d+)(?:[.,]\d{1,2})?(?!\d)/g;

export function parseMoneyMinor(value) {
  const text = String(value ?? "").replace(/[\u00a0\u202f]/g, " ").trim();
  if (!text) return null;
  const tokens = [...text.matchAll(PRICE_TOKEN)];
  // Ranges, several variant prices and mixed price labels are ambiguous.
  if (tokens.length !== 1) return null;
  let token = tokens[0][0].replace(/\s/g, "");
  let fraction = "";
  const decimal = token.match(/[.,](\d{1,2})$/);
  if (decimal) {
    fraction = decimal[1].padEnd(2, "0");
    token = token.slice(0, -decimal[0].length);
  }
  const majorDigits = token.replace(/[.,]/g, "");
  if (!/^\d+$/.test(majorDigits)) return null;
  const major = Number(majorDigits);
  const minor = fraction ? Number(fraction) : 0;
  const result = major * 100 + minor;
  return Number.isSafeInteger(result) && result > 0 && result <= 9_000_000_000_000 ? result : null;
}

export function formatMoneyMinor(value, currency = "RUB") {
  const amount = Number(value);
  if (!Number.isSafeInteger(amount) || amount < 0) return "";
  const normalizedCurrency = /^[A-Z]{3}$/.test(String(currency || "").toUpperCase())
    ? String(currency).toUpperCase()
    : "RUB";
  try {
    return new Intl.NumberFormat("ru-RU", {
      style: "currency",
      currency: normalizedCurrency,
      minimumFractionDigits: amount % 100 === 0 ? 0 : 2,
      maximumFractionDigits: 2,
    }).format(amount / 100);
  } catch {
    return `${new Intl.NumberFormat("ru-RU").format(amount / 100)} ${normalizedCurrency}`;
  }
}
