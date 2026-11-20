import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { PriceFilter } from "./price-filter";
import type { StationsGeoJSONCollection } from "@/types/station";

vi.mock("@/lib/i18n", () => ({ useI18n: () => ({ t: (k: string) => k }) }));
vi.mock("@/lib/currency", () => ({
  useCurrency: () => ({
    currency: "EUR", rates: null, symbol: "€", decimals: 3,
    formatPrice: (n: number) => n.toFixed(3), convert: (n: number) => n,
  }),
}));

function stations(prices: number[]): StationsGeoJSONCollection {
  return {
    type: "FeatureCollection",
    features: prices.map((price, i) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [0, 0] },
      properties: {
        id: `s${i}`, name: `Station ${String.fromCharCode(65 + i)}`, brand: null,
        address: "Street 1", city: "Town", price, fuelType: "B7", currency: "EUR",
      },
    })),
  } as StationsGeoJSONCollection;
}

describe("PriceFilter", () => {
  // The colour scale runs from P5 to P95, but the legend must never print a
  // lowest price above a station that is on the map.
  it("labels the legend with the real cheapest and dearest prices, matching the slider", () => {
    const { container } = render(
      <PriceFilter
        stations={stations([1.703, 1.76, 1.8, 2.1, 2.12])}
        maxPrice={null}
        onMaxPriceChange={() => {}}
        legendMin={1.76}
        legendMax={2.109}
      />,
    );
    const legendLabels = container.querySelectorAll("div.rounded-full + div > span");
    expect(legendLabels[0]).toHaveTextContent("1.703 €");
    expect(legendLabels[1]).toHaveTextContent("2.120 €");
    expect(screen.queryByText(/1\.760 €/)).toBeNull();
    expect(screen.queryByText(/2\.109 €/)).toBeNull();
  });

  // With the max-price filter on, the map hides every station above it, so the
  // legend must not name their prices.
  it("labels the legend with drawn stations only while the max-price filter is on", () => {
    const { container } = render(
      <PriceFilter
        stations={stations([1.703, 1.76, 1.8, 2.1, 2.12])}
        maxPrice={1.8}
        onMaxPriceChange={() => {}}
        legendMin={1.703}
        legendMax={1.8}
      />,
    );
    const legendLabels = container.querySelectorAll("div.rounded-full + div > span");
    expect(legendLabels[0]).toHaveTextContent("1.703 €");
    expect(legendLabels[1]).toHaveTextContent("1.800 €");
  });

  // On a route the detour filter hides corridor stations from the map but not
  // from the slider's range; the legend follows what is drawn.
  it("labels the legend with the drawn stations when the map hides some of them", () => {
    const all = stations([1.703, 1.76, 1.8, 2.1, 2.12]);
    const drawn = { ...all, features: all.features.slice(1, 4) };
    const { container } = render(
      <PriceFilter
        stations={all}
        drawnStations={drawn}
        maxPrice={null}
        onMaxPriceChange={() => {}}
        legendMin={1.76}
        legendMax={2.1}
      />,
    );
    const legendLabels = container.querySelectorAll("div.rounded-full + div > span");
    expect(legendLabels[0]).toHaveTextContent("1.760 €");
    expect(legendLabels[1]).toHaveTextContent("2.100 €");
  });

  // 1.005 * 1000 is 1004.9999999999999 and 2.007 * 1000 is 2007.0000000000002
  // in floating point; the labels must still read the exact prices.
  it("keeps exact prices exact at the ends of the legend and the slider", () => {
    const { container } = render(
      <PriceFilter
        stations={stations([1.005, 2.007])}
        maxPrice={null}
        onMaxPriceChange={() => {}}
        legendMin={1.005}
        legendMax={2.007}
      />,
    );
    const legendLabels = container.querySelectorAll("div.rounded-full + div > span");
    expect(legendLabels[0]).toHaveTextContent("1.005 €");
    expect(legendLabels[1]).toHaveTextContent("2.007 €");
    const slider = screen.getByRole("slider", { name: "filter.maxPrice" });
    expect(slider).toHaveAttribute("min", "1.005");
    expect(slider).toHaveAttribute("max", "2.007");
  });

  it("gives the max-price slider a name and a spoken price", () => {
    render(
      <PriceFilter
        stations={stations([1.703, 1.76, 1.8, 2.1, 2.12])}
        maxPrice={2.094}
        onMaxPriceChange={() => {}}
        legendMin={1.76}
        legendMax={2.109}
      />,
    );
    const slider = screen.getByRole("slider", { name: "filter.maxPrice" });
    expect(slider).toHaveAttribute("aria-valuetext", "2.094 €");
  });
});
