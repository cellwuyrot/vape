/** Unicode-aware matching for the public catalogue. No user text is evaluated as SQL. */
const normalize = (value = "") => String(value).normalize("NFKC").toLocaleLowerCase("ru-RU")
  .replace(/ё/g, "е").replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/\s+/g, " ");
const letters = { а:"a", б:"b", в:"v", г:"g", д:"d", е:"e", ж:"zh", з:"z", и:"i", й:"i", к:"k", л:"l", м:"m", н:"n", о:"o", п:"p", р:"r", с:"s", т:"t", у:"u", ф:"f", х:"h", ц:"ts", ч:"ch", ш:"sh", щ:"shch", ы:"y", э:"e", ю:"yu", я:"ya", ь:"", ъ:"" };
const latin = (value) => [...value].map((c) => Object.hasOwn(letters, c) ? letters[c] : c).join("");
function oneEdit(a, b) {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0, j = 0, n = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++n > 1) return false;
    if (a.length > b.length) i++; else if (b.length > a.length) j++; else { i++; j++; }
  }
  return n + Number(i < a.length || j < b.length) <= 1;
}

export function searchScore(query, fields) {
  const raw = normalize(query);
  const tokens = raw.split(" ").filter(Boolean);
  if (!tokens.length) return 0;
  const normalized = fields.map(normalize);
  const transliterated = normalized.map(latin);
  const words = normalized.map((field) => field.split(" ").filter(Boolean));
  const latinWords = transliterated.map((field) => field.split(" ").filter(Boolean));
  let score = 0;
  for (const token of tokens) {
    const trans = latin(token);
    let best = 0;
    for (let i = 0; i < normalized.length; i++) {
      let match = 0;
      if (words[i].some((word) => word === token)) match = 40;
      else if (words[i].some((word) => word.startsWith(token))) match = 28;
      else if (normalized[i].includes(token)) match = 18;
      else if (trans.length > 1 && latinWords[i].some((word) => word === trans || word.startsWith(trans))) match = 15;
      else if (token.length >= 4 && /\p{L}/u.test(token) && words[i].some((word) => word.length >= 4 && /\p{L}/u.test(word) && oneEdit(token, word))) match = 8;
      if (match) best = Math.max(best, match + (i === 0 ? 20 : i < 3 ? 12 : 0));
    }
    if (!best) return 0;
    score += best;
  }
  if (normalized[0] === raw) score += 100;
  else if (normalized[0]?.startsWith(raw)) score += 50;
  return score;
}
