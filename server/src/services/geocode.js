/**
 * Turns a free-text address into { lat, lng }.
 *
 * This is what lets the assignment engine use *real* distance between a
 * worker and a job from nothing but the addresses you already type in -
 * you don't need to look up or enter coordinates by hand. If geocoding
 * fails for any reason (address not found, offline, rate limited), the
 * caller just ends up with no coordinates and the assignment engine
 * automatically falls back to comparing location text instead - nothing
 * breaks, it's just less precise.
 *
 * Two providers, tried in order:
 *
 *   1. OpenStreetMap Nominatim - free, no API key, no signup. Capped at
 *      roughly 1 request/second and prone to returning 403 Forbidden if
 *      Nominatim decides your IP (or anyone sharing it - office wifi, an
 *      ISP's shared NAT, a VPN) has been too chatty recently. These blocks
 *      are enforced by Nominatim itself and usually clear on their own
 *      within ~20-24 hours; they are not a bug in this code.
 *   2. LocationIQ - only used as a fallback, and only if LOCATIONIQ_API_KEY
 *      is set in .env. Nominatim-compatible request/response shape, free
 *      tier around 5,000 requests/day, far less prone to the kind of block
 *      described above. Sign up free at https://locationiq.com to get a key.
 *      Completely optional - if you don't set a key, the app just relies on
 *      Nominatim (and the text-matching fallback) as before.
 *
 * For real production volume beyond either free tier, swap in a paid
 * geocoder - same function signature, different implementation.
 *
 * Every successful lookup (from either provider) is cached permanently in
 * the GeocodeCache collection, keyed by the normalized address text. Any
 * future request for that exact address - a different worker who happens
 * to share it, an edit that puts the address back to what it was, or
 * `npm run seed` recreating the same mock workers from scratch every run -
 * is served straight from the database with no external API call at all.
 * This is what stops repeated testing (or normal use over time) from
 * burning through Nominatim's/LocationIQ's rate limits for addresses
 * that are already known.
 */
import GeocodeCache from "../models/GeocodeCache.js";

const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";
const LOCATIONIQ_URL = "https://us1.locationiq.com/v1/search";
const NOMINATIM_MIN_INTERVAL_MS = 1100;
const LOCATIONIQ_MIN_INTERVAL_MS = 600;
const TIMEOUT_MS = 8000;

function makeThrottle(minIntervalMs) {
  let lastRequestAt = 0;
  return async function throttle() {
    const wait = lastRequestAt + minIntervalMs - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    lastRequestAt = Date.now();
  };
}

const throttleNominatim = makeThrottle(NOMINATIM_MIN_INTERVAL_MS);
const throttleLocationIq = makeThrottle(LOCATIONIQ_MIN_INTERVAL_MS);

async function fetchWithTimeout(url, headers) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { signal: controller.signal, headers });
  } finally {
    clearTimeout(timeout);
  }
}

function cacheKey(address) {
  return address.trim().toLowerCase();
}

async function getCachedCoords(address) {
  try {
    const hit = await GeocodeCache.findOne({ key: cacheKey(address) }).lean();
    return hit ? { lat: hit.lat, lng: hit.lng } : null;
  } catch (err) {
    // A cache miss due to an error should never block geocoding from
    // proceeding normally - just fall through and hit the real API.
    console.warn(`[geocode] cache lookup failed for "${address}": ${err.name}: ${err.message}`);
    return null;
  }
}

async function setCachedCoords(address, coords) {
  try {
    await GeocodeCache.findOneAndUpdate(
      { key: cacheKey(address) },
      { key: cacheKey(address), address, lat: coords.lat, lng: coords.lng },
      { upsert: true }
    );
  } catch (err) {
    console.warn(`[geocode] failed to cache result for "${address}": ${err.name}: ${err.message}`);
  }
}

function parseFirstResult(results) {
  if (!Array.isArray(results) || results.length === 0) return { error: "no-results" };
  const lat = Number(results[0].lat);
  const lng = Number(results[0].lon);
  if (Number.isNaN(lat) || Number.isNaN(lng)) return { error: "bad-coords" };
  return { coords: { lat, lng } };
}

async function geocodeViaNominatim(query) {
  await throttleNominatim();

  const contact = process.env.GEOCODE_CONTACT || "contact-not-set@example.com";
  const url = `${NOMINATIM_URL}?format=json&limit=1&q=${encodeURIComponent(query)}`;

  try {
    const res = await fetchWithTimeout(url, {
      "User-Agent": `WorkerAssignmentApp/1.0 (${contact})`,
      Accept: "application/json",
    });

    if (!res.ok) {
      console.warn(`[geocode] Nominatim returned ${res.status} ${res.statusText} for "${query}"`);
      return null;
    }

    const { coords, error } = parseFirstResult(await res.json());
    if (error === "no-results") {
      console.warn(`[geocode] Nominatim: no results for "${query}"`);
      return null;
    }
    if (error === "bad-coords") {
      console.warn(`[geocode] Nominatim returned unparseable coordinates for "${query}"`);
      return null;
    }
    return coords;
  } catch (err) {
    // Network error, timeout, bad JSON, "fetch is not defined" on old Node
    // versions, etc. - log the real reason instead of hiding it, but still
    // return null so the caller falls back rather than crashing.
    console.warn(`[geocode] Nominatim request failed for "${query}": ${err.name}: ${err.message}`);
    return null;
  }
}

async function geocodeViaLocationIq(query) {
  const apiKey = process.env.LOCATIONIQ_API_KEY;
  if (!apiKey) return null;

  await throttleLocationIq();

  const url = `${LOCATIONIQ_URL}?key=${encodeURIComponent(apiKey)}&format=json&limit=1&q=${encodeURIComponent(
    query
  )}`;

  try {
    const res = await fetchWithTimeout(url, { Accept: "application/json" });

    if (!res.ok) {
      console.warn(`[geocode] LocationIQ returned ${res.status} ${res.statusText} for "${query}"`);
      return null;
    }

    const { coords, error } = parseFirstResult(await res.json());
    if (error === "no-results") {
      console.warn(`[geocode] LocationIQ: no results for "${query}"`);
      return null;
    }
    if (error === "bad-coords") {
      console.warn(`[geocode] LocationIQ returned unparseable coordinates for "${query}"`);
      return null;
    }
    return coords;
  } catch (err) {
    console.warn(`[geocode] LocationIQ request failed for "${query}": ${err.name}: ${err.message}`);
    return null;
  }
}

/**
 * @param {string} address
 * @returns {Promise<{lat: number, lng: number} | null>}
 */
export async function geocodeAddress(address) {
  const query = (address || "").trim();
  if (!query) return null;

  const cached = await getCachedCoords(query);
  if (cached) {
    console.log(`[geocode] "${query}" already cached - skipping the API entirely`);
    return cached;
  }

  const primary = await geocodeViaNominatim(query);
  if (primary) {
    await setCachedCoords(query, primary);
    return primary;
  }

  if (process.env.LOCATIONIQ_API_KEY) {
    console.warn(`[geocode] falling back to LocationIQ for "${query}"`);
    const fallback = await geocodeViaLocationIq(query);
    if (fallback) {
      await setCachedCoords(query, fallback);
      return fallback;
    }
  }

  return null;
}

/**
 * Mutates and returns `data`, filling in lat/lng from `data.location` via
 * geocoding IF lat/lng weren't already explicitly provided. Lets a caller
 * type coordinates by hand to override geocoding when they want to. Used
 * for CREATE - there's no previous record to compare against, so "already
 * has coordinates on the incoming data" is the only thing to check.
 */
export async function fillCoordinatesFromLocation(data) {
  const hasManualCoords =
    data.lat !== undefined && data.lat !== null && !Number.isNaN(data.lat);

  if (!hasManualCoords && data.location) {
    const coords = await geocodeAddress(data.location);
    if (coords) {
      data.lat = coords.lat;
      data.lng = coords.lng;
    }
  }

  return data;
}

/**
 * The UPDATE equivalent of fillCoordinatesFromLocation. A record that
 * already has coordinates should NOT trigger a fresh geocoding request on
 * every edit - saving a worker again just to change their phone number, for
 * example, shouldn't hit the geocoder at all, since the frontend resubmits
 * their existing (unchanged) location and coordinates together.
 *
 * The one case that DOES need a fresh lookup: the location text itself
 * changed, but the coordinates coming in are still the OLD ones (because
 * the edit form pre-fills them from the record and the person only touched
 * the address field). Left alone, that would silently keep the previous
 * address's coordinates attached to the new address forever. So:
 *
 *   - location unchanged                                -> never geocode
 *   - location changed, coords also changed from before -> trust it (the
 *                                                            person deliberately
 *                                                            typed new
 *                                                            coordinates by hand)
 *   - location changed, coords match the old record      -> re-geocode
 *   - no coordinates present at all yet                  -> geocode
 *
 * @param {object|null} existing - the record as it is in the database now
 * @param {object} incoming - the fields about to be saved (mutated in place)
 */
export async function refreshCoordinatesOnUpdate(existing, incoming) {
  const location = incoming.location !== undefined ? incoming.location : existing?.location;
  const locationChanged =
    !!existing && incoming.location !== undefined && incoming.location !== existing.location;

  const hasProvidedCoords =
    incoming.lat !== undefined && incoming.lat !== null && !Number.isNaN(incoming.lat);

  const matchesExistingCoords =
    hasProvidedCoords &&
    existing?.lat !== undefined &&
    existing?.lat !== null &&
    Number(existing.lat) === Number(incoming.lat) &&
    Number(existing.lng) === Number(incoming.lng);

  const needsGeocode = !hasProvidedCoords || (locationChanged && matchesExistingCoords);

  if (needsGeocode && location) {
    const coords = await geocodeAddress(location);
    if (coords) {
      incoming.lat = coords.lat;
      incoming.lng = coords.lng;
    } else if (locationChanged) {
      // Couldn't get coordinates for the NEW address - drop the stale ones
      // rather than silently keep the old address's location attached.
      incoming.lat = null;
      incoming.lng = null;
    }
  }

  return incoming;
}
