/**
 * Location comparison helpers.
 *
 * If a worker and a job both have lat/lng set, we use real great-circle
 * distance (Haversine formula). Otherwise we fall back to simple, case
 * insensitive text matching on the free-text location fields - good enough
 * when everything is entered as suburb/city names.
 */

const EARTH_RADIUS_KM = 6371;

export function hasCoords(entity) {
  return typeof entity?.lat === "number" && typeof entity?.lng === "number";
}

export function haversineKm(a, b) {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);

  const h =
    Math.sin(dLat / 2) ** 2 + Math.sin(dLng / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  const c = 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
  return EARTH_RADIUS_KM * c;
}

function toRad(deg) {
  return (deg * Math.PI) / 180;
}

function normalize(str) {
  return (str || "").trim().toLowerCase();
}

export function locationsMatch(a, b) {
  const na = normalize(a);
  const nb = normalize(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  return na.includes(nb) || nb.includes(na);
}

/**
 * Returns { score, distanceKm | null, method } where score is 0-20.
 */
export function scoreLocation(worker, job) {
  if (hasCoords(worker) && hasCoords(job)) {
    const distanceKm = haversineKm(worker, job);
    let score = 0;
    if (distanceKm <= 5) score = 20;
    else if (distanceKm <= 20) score = 14;
    else if (distanceKm <= 50) score = 8;
    else if (distanceKm <= 100) score = 4;
    else score = 0;
    return { score, distanceKm: Math.round(distanceKm * 10) / 10, method: "coordinates" };
  }

  if (locationsMatch(worker.location, job.location)) {
    const exact = normalize(worker.location) === normalize(job.location);
    return { score: exact ? 20 : 12, distanceKm: null, method: "text" };
  }

  return { score: 0, distanceKm: null, method: "text" };
}
