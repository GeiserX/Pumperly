import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { forwardRef, useEffect } from "react";
import type { MapRef } from "react-map-gl/maplibre";
import type { StationGeoJSON } from "@/types/station";
import { HomeClient } from "./home-client";

// Regression for the first-locate fit: it must frame the user and the nearby
// stations clear of the cards drawn over the map, as measured on screen.

let navbarProps: Record<string, unknown> = {};
let searchPanelProps: Record<string, unknown> = {};
const fitBounds = vi.fn();
const flyTo = vi.fn();

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

// The map renders the legend card inside a `display: contents` wrapper, as
// map-view.tsx does, so the fit has to measure the wrapper's child.
vi.mock("@/components/map/map-view", () => ({
  MapView: forwardRef<MapRef, Record<string, unknown>>(function MockMapView(props, ref) {
    // The map loads once: report ready on mount only. (Re-reporting on every
    // render loops here, because the stubbed geolocation answers synchronously.)
    const onMapReady = props.onMapReady as (() => void) | undefined;
    useEffect(() => {
      (ref as React.MutableRefObject<MapRef | null>).current = { flyTo, fitBounds } as unknown as MapRef;
      onMapReady?.();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    return (
      <div data-map-overlay className="contents">
        <div data-box="legend" />
      </div>
    );
  }),
}));

vi.mock("@/components/search/search-panel", () => ({
  SearchPanel: (props: Record<string, unknown>) => {
    useEffect(() => { searchPanelProps = props; }, [props]);
    return <div data-map-overlay data-box="panel" />;
  },
}));

interface Box { top: number; right: number; bottom: number; left: number }
let boxes: Record<string, Box> = {};

function rect(b: Box): DOMRect {
  const width = b.right - b.left;
  const height = b.bottom - b.top;
  return { ...b, width, height, x: b.left, y: b.top, toJSON: () => b } as DOMRect;
}

function station(id: string, coordinates: [number, number]): StationGeoJSON {
  return {
    type: "Feature",
    geometry: { type: "Point", coordinates },
    properties: { id, name: id, brand: id, address: "", city: "Town", price: 1.5, reportedAt: null, fuelType: "B7", currency: "EUR" },
  };
}

const USER: [number, number] = [-3.70, 40.42];
// Cheapest first, as NearbyCheapest reports them.
const NEARBY = [
  station("Station A", [-3.70, 40.447]),
  station("Station B", [-3.70, 40.411]),
  station("Station C", [-3.69, 40.42]),
];

async function locateAndLoadNearby() {
  render(<HomeClient defaultFuel="B7" center={[-3.7, 40.4]} zoom={6} clusterStations={false} locale="es" />);
  await waitFor(() => expect(typeof navbarProps.onGeolocate).toBe("function"));
  act(() => (navbarProps.onGeolocate as () => void)());
  await waitFor(() => expect(flyTo).toHaveBeenCalled());
  act(() => (searchPanelProps.onNearbyLoaded as (s: StationGeoJSON[]) => void)(NEARBY));
  await waitFor(() => expect(fitBounds).toHaveBeenCalledTimes(1));
  const [bounds, options] = fitBounds.mock.calls[0] as [[[number, number], [number, number]], { padding: Box }];
  return { bounds, padding: options.padding };
}

describe("HomeClient — first-locate fit of the nearby stations", () => {
  beforeEach(() => {
    navbarProps = {};
    searchPanelProps = {};
    fitBounds.mockClear();
    flyTo.mockClear();
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => [] }) as unknown as Response));
    Object.defineProperty(navigator, "geolocation", {
      configurable: true,
      value: {
        getCurrentPosition: (ok: PositionCallback) =>
          ok({ coords: { longitude: USER[0], latitude: USER[1] } } as GeolocationPosition),
        watchPosition: () => 1,
        clearWatch: () => {},
      },
    });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const name = this.dataset.box ?? (this.querySelector('[data-box="panel"]') ? "map" : null);
      return name && boxes[name] ? rect(boxes[name]) : rect({ top: 0, right: 0, bottom: 0, left: 0 });
    });
  });
  afterEach(() => {
    window.history.replaceState(null, "", "/");
    // Unmount first: the position watch clears itself through navigator.geolocation.
    cleanup();
    delete (navigator as { geolocation?: unknown }).geolocation;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("keeps the stations below the search card and above the legend card on a 402x874 phone", async () => {
    boxes = {
      map: { top: 44, right: 402, bottom: 874, left: 0 },
      panel: { top: 52, right: 394, bottom: 299, left: 8 },
      legend: { top: 700, right: 196, bottom: 850, left: 12 },
    };
    const { bounds, padding } = await locateAndLoadNearby();

    // Clear of the cards as drawn, plus room for a marker radius (8 px).
    expect(padding.top).toBeGreaterThanOrEqual(299 - 44 + 8);
    expect(padding.bottom).toBeGreaterThanOrEqual(874 - 700 + 8);
    // The user and all three listed stations are framed.
    expect(bounds).toEqual([[-3.70, 40.411], [-3.69, 40.447]]);
  });

  it("frames only the user and the cheapest station when a 320x568 phone leaves little map between the cards", async () => {
    boxes = {
      map: { top: 44, right: 320, bottom: 568, left: 0 },
      panel: { top: 52, right: 312, bottom: 299, left: 8 },
      legend: { top: 394, right: 196, bottom: 544, left: 12 },
    };
    const { bounds, padding } = await locateAndLoadNearby();

    expect(padding.top).toBeGreaterThanOrEqual(299 - 44 + 8);
    expect(padding.bottom).toBeGreaterThanOrEqual(568 - 394 + 8);
    expect(bounds).toEqual([[-3.70, 40.42], [-3.70, 40.447]]);
  });
});
