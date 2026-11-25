// Страна как подпись из источника: не утверждает страну производства.
const COUNTRIES = ["Казахстан", "Кыргызстан", "Киргизстан", "Узбекистан", "Армения", "Швейцария", "Япония", "Индонезия", "Корея", "Южная Корея", "Россия", "Турция", "ОАЭ", "Китай", "Сербия", "Греция", "Польша", "Украина", "Беларусь", "Белоруссия", "Азербайджан", "Грузия", "Италия", "Германия", "Чехия", "Малайзия", "Филиппины", "Вьетнам"];
const aliases = new Map(COUNTRIES.map((x) => [x.toLocaleLowerCase("ru-RU"), x]));
aliases.set("киргизстан", "Кыргызстан"); aliases.set("белоруссия", "Беларусь");
export function countryFromName(name) {
  const text = String(name || "").trim();
  for (const label of [...COUNTRIES].sort((a, b) => b.length - a.length)) {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = text.match(new RegExp(`^(.*?)(?:\\s+[—–-]\\s*|\\s*\\(\\s*|\\s+)(${escaped})(?:\\s*\\))?\\s*$`, "iu"));
    if (match && match[1].trim()) return { country: aliases.get(label.toLocaleLowerCase("ru-RU")), base: match[1].trim() };
  }
  return null;
}
export function countryFromAttributes(attributes) {
  if (!attributes || typeof attributes !== "object" || Array.isArray(attributes)) return "";
  const key = Object.keys(attributes).find((x) => /^(country|страна)$/iu.test(x.trim()));
  return key && typeof attributes[key] === "string" ? attributes[key].trim() : "";
}
export function variantCountry(variant) {
  let attributes = {};
  try { attributes = typeof variant.attributes_json === "string" ? JSON.parse(variant.attributes_json) : (variant.attributes || {}); } catch { /* malformed data is not changed */ }
  return countryFromAttributes(attributes) || countryFromName(variant.name)?.country || "";
}
