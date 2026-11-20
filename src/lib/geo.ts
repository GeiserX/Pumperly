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

/** A screen rectangle in px, as getBoundingClientRect gives it. */
export interface ScreenBox {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/**
 * fitBounds padding that keeps every fitted point clear of the cards drawn
 * over the map, plus `margin` px for the marker radius.
 *
 * Each card blocks one edge strip of the map: the one that costs the least
 * share of the map. A card across a phone's full width blocks the top or the
 * bottom; a narrow card in a corner of a wide screen blocks that side.
 */
export function paddingClearOf(map: ScreenBox, overlays: ScreenBox[], margin: number): ScreenBox {
  const width = map.right - map.left;
  const height = map.bottom - map.top;
  const pad: ScreenBox = { top: 0, right: 0, bottom: 0, left: 0 };
  if (width <= 0 || height <= 0) return { top: margin, right: margin, bottom: margin, left: margin };
  for (const o of overlays) {
    const top = Math.max(o.top, map.top);
    const bottom = Math.min(o.bottom, map.bottom);
    const left = Math.max(o.left, map.left);
    const right = Math.min(o.right, map.right);
    if (bottom <= top || right <= left) continue;
    const strips: [keyof ScreenBox, number, number][] = [
      ["top", bottom - map.top, height],
      ["bottom", map.bottom - top, height],
      ["left", right - map.left, width],
      ["right", map.right - left, width],
    ];
    const [side, size] = strips.reduce((best, s) => (s[1] / s[2] < best[1] / best[2] ? s : best));
    pad[side] = Math.max(pad[side], size);
  }
  return {
    top: pad.top + margin,
    right: pad.right + margin,
    bottom: pad.bottom + margin,
    left: pad.left + margin,
  };
}
