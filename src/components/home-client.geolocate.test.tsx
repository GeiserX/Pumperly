import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { forwardRef, useEffect } from "react";
import type { MapRef } from "react-map-gl/maplibre";
import { HomeClient } from "./home-client";

// With location off or unavailable, the page must say so in words (and, in the
// iOS app, offer the way to Settings) instead of a 3-second red icon.

let navbarProps: Record<string, unknown> = {};
const flyTo = vi.fn();
const fitBounds = vi.fn();

vi.mock("@/lib/theme", () => ({ ThemeProvider: ({ children }: { children: React.ReactNode }) => children }));
vi.mock("@/lib/currency", () => ({ CurrencyProvider: ({ children }: { children: React.ReactNode }) => children }));
vi.mock("@/lib/i18n", () => ({
  I18nProvider: ({ children }: { children: React.ReactNode }) => children,
  useI18n: () => ({ t: (k: string) => k, locale: "es", setLocale: () => {} }),
}));
vi.mock("@/lib/use-detour-stream", () => ({ useDetourStream: () => ({ detourMap: {}, detoursLoading: false }) }));
vi.mock("@/components/nav/navbar", () => ({
  Navbar: (props: Record<string, unknown>) => {
    useEffect(() => { navbarProps = props; }, [props]);
    return null;
  },
}));
vi.mock("@/components/map/map-view", () => ({
  MapView: forwardRef<MapRef, Record<string, unknown>>(function MockMapView(props, ref) {
    const onMapReady = props.onMapReady as (() => void) | undefined;
    useEffect(() => {
      (ref as React.MutableRefObject<MapRef | null>).current = { flyTo, fitBounds } as unknown as MapRef;
      onMapReady?.();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    return null;
  }),
}));
vi.mock("@/components/search/search-panel", () => ({ SearchPanel: () => null }));

type Answer = { code: number } | { coords: [number, number] };
// What each getCurrentPosition call answers, in order; the last one repeats.
let answers: Answer[] = [];
let calls = 0;

function positionError(code: number): GeolocationPositionError {
  return { code, message: "", PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3 } as GeolocationPositionError;
}

function stubGeolocation() {
  Object.defineProperty(navigator, "geolocation", {
    configurable: true,
    value: {
      getCurrentPosition: (ok: PositionCallback, fail: PositionErrorCallback) => {
        const a = answers[Math.min(calls++, answers.length - 1)];
        if ("code" in a) fail(positionError(a.code));
        else ok({ coords: { longitude: a.coords[0], latitude: a.coords[1] } } as GeolocationPosition);
      },
      watchPosition: () => 1,
      clearWatch: () => {},
    },
  });
}

function renderHome() {
  render(<HomeClient defaultFuel="B7" center={[-3.7, 40.4]} zoom={6} clusterStations={false} locale="es" />);
}

function tapLocate() {
  act(() => (navbarProps.onGeolocate as () => void)());
}

describe("HomeClient — location off or unavailable", () => {
  beforeEach(() => {
    navbarProps = {};
    answers = [];
    calls = 0;
    flyTo.mockClear();
    fitBounds.mockClear();
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => [] }) as unknown as Response));
    stubGeolocation();
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    delete (navigator as { geolocation?: unknown }).geolocation;
    delete (navigator as { permissions?: unknown }).permissions;
    window.history.replaceState(null, "", "/");
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("keeps a denial message on screen, with a Settings link in the iOS app", () => {
    vi.useFakeTimers();
    vi.stubGlobal("webkit", { messageHandlers: { pumperlyGeolocation: { postMessage: () => {} } } });
    answers = [{ code: 1 }];
    renderHome();
    tapLocate();
    act(() => { vi.advanceTimersByTime(5000); });

    expect(screen.getByText("geo.deniedHelp")).toBeTruthy();
    const link = screen.getByRole("link", { name: "geo.openSettings" });
    expect(link.getAttribute("href")).toBe("app-settings:");
  });

  it("offers no Settings link in a browser", () => {
    answers = [{ code: 1 }];
    renderHome();
    tapLocate();

    expect(screen.getByText("geo.deniedHelp")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "geo.openSettings" })).toBeNull();
  });

  it("reports a timeout as 'could not find you', not as a denial", () => {
    answers = [{ code: 3 }];
    renderHome();
    tapLocate();

    expect(screen.getByText("geo.unavailable")).toBeTruthy();
    expect(screen.queryByText("geo.deniedHelp")).toBeNull();
    expect(navbarProps.geoState).toBe("idle");
  });

  it("says location is off when the page opens with it already denied", async () => {
    Object.defineProperty(navigator, "permissions", {
      configurable: true,
      value: { query: () => Promise.resolve({ state: "denied" }) },
    });
    answers = [{ coords: [-3.7, 40.42] }];
    renderHome();

    expect(await screen.findByText("geo.deniedHelp")).toBeTruthy();
    expect(calls).toBe(0);
  });

  it("clears the message once a position arrives, and can be closed", () => {
    // The first answer goes to the automatic locate when the map is ready.
    answers = [{ code: 1 }, { code: 1 }, { code: 1 }, { coords: [-3.7, 40.42] }];
    renderHome();
    tapLocate();
    expect(screen.getByText("geo.deniedHelp")).toBeTruthy();

    act(() => { screen.getByRole("button", { name: "common.close" }).click(); });
    expect(screen.queryByText("geo.deniedHelp")).toBeNull();

    tapLocate();
    expect(screen.getByText("geo.deniedHelp")).toBeTruthy();
    tapLocate();
    expect(screen.queryByText("geo.deniedHelp")).toBeNull();
    expect(flyTo).toHaveBeenCalled();
  });
});
