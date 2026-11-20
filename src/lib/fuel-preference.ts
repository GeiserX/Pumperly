/**
 * The visitor's fuel setting, shared by the server page, the map and the iOS app.
 *
 * - A pick in the map's fuel picker is stored in the `pumperly-fuel` cookie, so
 *   the server renders that fuel on the next visit and hydration does not flip it.
 * - A bare `?fuel=<code>` (no route, no station) is an explicit choice, usually
 *   handed over by the iOS app; it is stored the same way.
 * - A shared route or station link shows its own fuel but never changes the
 *   stored one.
 * - Inside the iOS app, a pick is posted to the `pumperlyFuel` message handler
 *   so the widget, Shortcuts and watch follow. Browsers have no such handler.
 */

import { fuelTypeEnum, type FuelType } from "@/types/fuel";
import { parseRouteParams, parseStationParams } from "@/lib/share-url";

export const FUEL_COOKIE = "pumperly-fuel";
const ONE_YEAR_S = 60 * 60 * 24 * 365;

/** A known fuel code, or null. */
export function parseFuel(v: string | null | undefined): FuelType | null {
  const parsed = fuelTypeEnum.safeParse(v);
  return parsed.success ? parsed.data : null;
}

/** The fuel of a bare `?fuel=` link: no route and no station link in the query. */
export function bareFuel(sp: URLSearchParams): FuelType | null {
  if (parseRouteParams(sp)) return null;
  const station = parseStationParams(sp);
  if (station && station.lat != null && station.lng != null) return null;
  return parseFuel(sp.get("fuel"));
}

/** The fuel the page opens on: a shared link, then a bare `?fuel=`, then the cookie, then the site default. */
export function resolveInitialFuel(o: {
  linkFuel: FuelType | null;
  bareFuel: FuelType | null;
  cookieFuel: FuelType | null;
  defaultFuel: string;
}): string {
  return o.linkFuel ?? o.bareFuel ?? o.cookieFuel ?? o.defaultFuel;
}

/** The fuel stored in the cookie, or null. */
export function readFuelCookie(): FuelType | null {
  if (typeof document === "undefined") return null;
  try {
    const pair = document.cookie.split("; ").find((c) => c.startsWith(`${FUEL_COOKIE}=`));
    return parseFuel(pair?.slice(FUEL_COOKIE.length + 1));
  } catch {
    return null;
  }
}

/**
 * Remember the fuel for a year, on the whole site. Safari caps a cookie written
 * from script at 7 days, so callers re-write it on every visit to renew it.
 */
export function writeFuelCookie(code: FuelType): void {
  if (typeof document === "undefined") return;
  try {
    const secure = window.location.protocol === "https:" ? "; secure" : "";
    document.cookie = `${FUEL_COOKIE}=${code}; path=/; max-age=${ONE_YEAR_S}; samesite=lax${secure}`;
  } catch {
    // A page where cookies are blocked must still let the visitor pick a fuel.
  }
}

interface WebkitWindow {
  webkit?: { messageHandlers?: { pumperlyFuel?: { postMessage: (msg: { fuel: FuelType }) => void } } };
}

/** Tell the iOS app about a pick. Does nothing in a browser. */
export function notifyNativeFuel(code: FuelType): void {
  if (typeof window === "undefined") return;
  try {
    (window as unknown as WebkitWindow).webkit?.messageHandlers?.pumperlyFuel?.postMessage({ fuel: code });
  } catch {
    // The app's handler is optional; a failure here must never break the picker.
  }
}
