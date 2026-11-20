import type { StationGeoJSON } from "@/types/station";

const EARTH_RADIUS_KM = 6371;

/** Great-circle distance in km between two [lng, lat] points (haversine). */
export function distanceKm(a: [number, number], b: [number, number]): number {
  const rad = Math.PI / 180;
  const dLat = (b[1] - a[1]) * rad;
  const dLng = (b[0] - a[0]) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

export interface NearbyStation {
  station: StationGeoJSON;
  distanceKm: number;
}

/**
 * The `n` cheapest priced stations, cheapest first; equal prices go nearest
 * first. Stations without a price are left out: they can't be "cheapest".
 */
export function cheapestNearby(
  features: StationGeoJSON[],
  from: [number, number],
  n = 3,
): NearbyStation[] {
  return features
    .filter((f) => f.properties.price != null)
    .map((station) => ({ station, distanceKm: distanceKm(from, station.geometry.coordinates) }))
    .sort((a, b) => a.station.properties.price! - b.station.properties.price! || a.distanceKm - b.distanceKm)
    .slice(0, n);
}
