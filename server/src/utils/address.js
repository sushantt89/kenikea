// A scraped address sometimes comes with trailing travel info from the
// source page (e.g. "12.4 km, 18 mins from service centre") - not part of
// the address. This keeps the real address only, leaving everything else
// exactly as it was. Used when scraping and when building a calendar
// event's location (so jobs scraped earlier are cleaned up too).
const TRAVEL_INFO = /\b\d+(?:[.,]\d+)?\s*(?:km|kms|kilomet(?:er|re)s?|mins?|minutes?|hrs?|hours?)\b/i;

export function cleanAddress(address) {
  if (!address) return "";
  let text = String(address);

  // "(12 km, 18 mins away)" style brackets.
  text = text.replace(/\([^)]*\)/g, (m) => (TRAVEL_INFO.test(m) ? "" : m));

  // Pieces separated by a comma / line break / " - " / " | ": drop the ones
  // that are travel info, together with the separator before them.
  const pieces = text.split(/(\s*(?:,|\n|\s-\s|\s\|\s)\s*)/);
  let out = pieces[0] || "";
  for (let i = 1; i < pieces.length; i += 2) {
    const sep = pieces[i];
    const piece = pieces[i + 1] || "";
    if (TRAVEL_INFO.test(piece)) continue;
    out += sep + piece;
  }

  // Travel info glued on with just a space (e.g. "... SA 5082 7.65 km / 14
  // mins to job site"): cut everything from the distance onwards. An
  // address never contains a "N km" / "N mins" figure itself.
  const cut = out.search(TRAVEL_INFO);
  if (cut > 0) out = out.slice(0, cut);

  return out.replace(/\s{2,}/g, " ").replace(/[\s,|\/-]+$/, "").trim();
}
