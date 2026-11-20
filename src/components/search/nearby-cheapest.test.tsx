import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { StationGeoJSON, StationsGeoJSONCollection } from "@/types/station";

// i18n: echo the key back so we can assert on stable identifiers.
vi.mock("@/lib/i18n", () => ({
  useI18n: () => ({ t: (k: string) => k, locale: "en" }),
}));

import { NearbyCheapest } from "./nearby-cheapest";

const ME: [number, number] = [-3.7, 40.4];
// A point `km` due north of ME (1° of latitude ≈ 111.195 km on the haversine sphere).
const north = (km: number): [number, number] => [ME[0], ME[1] + km / 111.195];

function station(id: string, brand: string, coordinates: [number, number], price: number): StationGeoJSON {
  return {
    type: "Feature",
    geometry: { type: "Point", coordinates },
    properties: { id, name: brand, brand, address: "Street 1", city: "Town", price, reportedAt: null, fuelType: "B7", currency: "EUR" },
  };
}

const NEAREST: StationsGeoJSONCollection = {
  type: "FeatureCollection",
  features: [
    station("a", "Station A", north(0.4), 1.85),
    station("b", "Station B", north(1.3), 1.799),
    station("c", "Station C", north(2.1), 1.799),
  ],
};

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(async () => new Response(JSON.stringify(NEAREST), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("NearbyCheapest", () => {
  it("asks the nearest-stations API around the user for the chosen fuel", async () => {
    render(<NearbyCheapest userLocation={ME} selectedFuel="B7" onFlyTo={() => {}} />);
    await screen.findByText(/Station B/);
    const url = new URL(String(fetchMock.mock.calls[0][0]), "http://localhost");
    expect(url.pathname).toBe("/api/stations/nearest");
    expect(url.searchParams.get("fuel")).toBe("B7");
    expect(Number(url.searchParams.get("lat"))).toBeCloseTo(ME[1], 1);
    expect(Number(url.searchParams.get("lon"))).toBeCloseTo(ME[0], 1);
  });

  it("lists the cheapest first, ties broken by distance, and tags the first row", async () => {
    render(<NearbyCheapest userLocation={ME} selectedFuel="B7" onFlyTo={() => {}} />);
    await screen.findByText(/Station B/);
    const rows = screen.getAllByRole("button");
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringContaining("Station B"),
      expect.stringContaining("Station C"),
      expect.stringContaining("Station A"),
    ]);
    expect(rows[0]).toHaveTextContent("nearby.cheapest");
    expect(rows[0]).toHaveTextContent("1.3 km");
    expect(rows[0]).toHaveTextContent("1.799 €/L");
    expect(rows[1]).not.toHaveTextContent("nearby.cheapest");
  });

  it("flies to the station and opens it when a row is tapped", async () => {
    const onFlyTo = vi.fn();
    render(<NearbyCheapest userLocation={ME} selectedFuel="B7" onFlyTo={onFlyTo} />);
    fireEvent.click(await screen.findByRole("button", { name: /Station B/ }));
    expect(onFlyTo).toHaveBeenCalledWith(north(1.3), "b");
  });

  it("reports the listed stations so the map can frame them", async () => {
    const onLoaded = vi.fn();
    render(<NearbyCheapest userLocation={ME} selectedFuel="B7" onFlyTo={() => {}} onLoaded={onLoaded} />);
    await waitFor(() => expect(onLoaded).toHaveBeenCalled());
    expect(onLoaded.mock.calls[0][0].map((s: StationGeoJSON) => s.properties.id)).toEqual(["b", "c", "a"]);
  });

  it("says so when no station nearby has a price", async () => {
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ type: "FeatureCollection", features: [] }), { status: 200 }));
    render(<NearbyCheapest userLocation={ME} selectedFuel="B7" onFlyTo={() => {}} />);
    expect(await screen.findByText("nearby.empty")).toBeInTheDocument();
  });
});
