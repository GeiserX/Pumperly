import { describe, it, expect } from "vitest";
import type { StationGeoJSON } from "@/types/station";
import { distanceKm, cheapestNearby, paddingClearOf } from "./geo";

function station(id: string, coordinates: [number, number], price: number | null): StationGeoJSON {
  return {
    type: "Feature",
    geometry: { type: "Point", coordinates },
    properties: { id, name: id, brand: id, address: "", city: "Town", price, reportedAt: null, fuelType: "B7", currency: "EUR" },
  };
}

describe("distanceKm", () => {
  it("is zero for the same point", () => {
    expect(distanceKm([-3.7038, 40.4168], [-3.7038, 40.4168])).toBe(0);
  });

  it("measures Puerta del Sol to Embajadores as about 1.2 km", () => {
    expect(distanceKm([-3.7038, 40.4168], [-3.7025, 40.4060])).toBeCloseTo(1.2, 1);
  });

  it("counts a degree of longitude shorter away from the equator", () => {
    expect(distanceKm([0, 0], [1, 0])).toBeCloseTo(111.2, 1);
    expect(distanceKm([0, 60], [1, 60])).toBeCloseTo(55.6, 1);
  });
});

describe("cheapestNearby", () => {
  const me: [number, number] = [0, 0];
  const kmNorth = (km: number): [number, number] => [0, km / 111.195];

  it("sorts by price, then by distance, and drops unpriced stations", () => {
    const list = cheapestNearby(
      [
        station("A", kmNorth(0.4), 1.85),
        station("B", kmNorth(1.3), 1.799),
        station("C", kmNorth(2.1), 1.799),
        station("D", kmNorth(0.1), null),
      ],
      me,
    );
    expect(list.map((s) => s.station.properties.id)).toEqual(["B", "C", "A"]);
    expect(list[0].distanceKm).toBeCloseTo(1.3, 2);
  });

  it("keeps only the first n", () => {
    const list = cheapestNearby([station("A", kmNorth(1), 1.9), station("B", kmNorth(2), 1.8)], me, 1);
    expect(list.map((s) => s.station.properties.id)).toEqual(["B"]);
  });
});

describe("paddingClearOf", () => {
  // A 402x874 phone: map below a 44 px top bar.
  const phoneMap = { top: 44, right: 402, bottom: 874, left: 0 };

  it("pads the top past a full-width search card and the bottom past the legend card", () => {
    const searchCard = { top: 52, right: 394, bottom: 299, left: 8 };
    const legendCard = { top: 700, right: 196, bottom: 850, left: 12 };
    expect(paddingClearOf(phoneMap, [searchCard, legendCard], 24)).toEqual({
      top: 299 - 44 + 24,
      right: 24,
      bottom: 874 - 700 + 24,
      left: 24,
    });
  });

  it("pads the left past a side panel on a wide screen", () => {
    const wideMap = { top: 56, right: 1280, bottom: 800, left: 0 };
    const panel = { top: 68, right: 352, bottom: 420, left: 12 };
    const legendCard = { top: 626, right: 196, bottom: 776, left: 12 };
    expect(paddingClearOf(wideMap, [panel, legendCard], 24)).toEqual({ top: 24, right: 24, bottom: 24, left: 352 + 24 });
  });

  it("ignores a card outside the map and returns only the margin", () => {
    expect(paddingClearOf(phoneMap, [{ top: 0, right: 402, bottom: 40, left: 0 }], 10)).toEqual({ top: 10, right: 10, bottom: 10, left: 10 });
  });
});
