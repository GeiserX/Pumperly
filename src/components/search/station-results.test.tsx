import { describe, it, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { StationGeoJSON } from "@/types/station";

// --- Mocks ---------------------------------------------------------------
// i18n: echo the key back so we can assert on stable identifiers (badge labels,
// sort/basis button text).
vi.mock("@/lib/i18n", () => ({
  useI18n: () => ({ t: (k: string) => k }),
}));

// currency: native EUR display. Keep the real CURRENCIES table so per-station
// symbol/decimals lookups behave like production; formatPrice mirrors EUR (3 dp).
vi.mock("@/lib/currency", async () => {
  const actual = await vi.importActual<typeof import("@/lib/currency")>("@/lib/currency");
  return {
    CURRENCIES: actual.CURRENCIES,
    useCurrency: () => ({ symbol: "€", formatPrice: (p: number) => p.toFixed(3) }),
  };
});

import { StationResults } from "./station-results";

function makeStation(
  id: string,
  overrides: Partial<StationGeoJSON["properties"]> = {},
  coords: [number, number] = [-3.7, 40.4],
): StationGeoJSON {
  return {
    type: "Feature",
    geometry: { type: "Point", coordinates: coords },
    properties: {
      id,
      name: `Station ${id}`,
      brand: `Brand ${id}`,
      address: "Addr",
      city: "City",
      price: 1.5,
      reportedAt: null,
      fuelType: "E5",
      currency: "EUR",
      routeFraction: 0.5,
      detourMin: 3,
      ...overrides,
    },
  };
}

const STATIONS: StationGeoJSON[] = [
  makeStation("a", { brand: "Repsol", price: 1.499, detourMin: 5 }, [-3.70, 40.40]),
  makeStation("b", { brand: "Cepsa", price: 1.612, detourMin: 1 }, [-3.71, 40.41]),
  makeStation("c", { brand: "BP", price: 1.555, detourMin: 3 }, [-3.72, 40.42]),
];

function renderResults(props: Partial<React.ComponentProps<typeof StationResults>> = {}) {
  const onSortByChange = vi.fn();
  const onDetourBasisChange = vi.fn();
  const onStationSelect = vi.fn();
  const onStationToggleOff = vi.fn();
  render(
    <StationResults
      stationList={STATIONS}
      avgPrice={null}
      cheapestId="a"
      shortestDetourId="b"
      balancedId="c"
      sortBy="price"
      onSortByChange={onSortByChange}
      detourBasis="selected"
      onDetourBasisChange={onDetourBasisChange}
      corridorKm={5}
      primaryRoute={null}
      stationLegMsg={null}
      onStationToggleOff={onStationToggleOff}
      onStationSelect={onStationSelect}
      {...props}
    />,
  );
  return { onSortByChange, onDetourBasisChange, onStationSelect, onStationToggleOff };
}

describe("StationResults", () => {
  it("renders each station's brand and native-formatted price", () => {
    renderResults();
    expect(screen.getByText("Repsol")).toBeInTheDocument();
    expect(screen.getByText("Cepsa")).toBeInTheDocument();
    expect(screen.getByText("BP")).toBeInTheDocument();
    // EUR formats to 3 decimals; price + symbol share one span ("1.499 €").
    expect(screen.getByText(/1\.499\s*€/)).toBeInTheDocument();
    expect(screen.getByText(/1\.612\s*€/)).toBeInTheDocument();
    expect(screen.getByText(/1\.555\s*€/)).toBeInTheDocument();
  });

  it("shows cheapest / leastDetour / balanced badges on the right stations", () => {
    renderResults();
    // Each badge appears exactly once (cheapestId=a, shortestDetourId=b, balancedId=c).
    const cheapest = screen.getByText("stations.cheapest");
    const leastDetour = screen.getByText("stations.leastDetour");
    const balanced = screen.getByText("stations.balanced");

    // Badge for cheapest sits in the same row as "Repsol" (station a).
    expect(cheapest.closest("button")).toHaveTextContent("Repsol");
    expect(leastDetour.closest("button")).toHaveTextContent("Cepsa");
    expect(balanced.closest("button")).toHaveTextContent("BP");
  });

  it("fires onStationSelect with the station's coords and id when a row is clicked", async () => {
    const user = userEvent.setup();
    const { onStationSelect } = renderResults();

    await user.click(screen.getByText("Repsol"));
    expect(onStationSelect).toHaveBeenCalledTimes(1);
    expect(onStationSelect).toHaveBeenCalledWith([-3.70, 40.40], "a");
  });

  it("fires onStationToggleOff when the already-selected station is clicked", async () => {
    const user = userEvent.setup();
    const { onStationSelect, onStationToggleOff } = renderResults({ selectedStationId: "a" });

    await user.click(screen.getByText("Repsol"));
    expect(onStationToggleOff).toHaveBeenCalledTimes(1);
    expect(onStationSelect).not.toHaveBeenCalled();
  });

  it("fires onSortByChange when a sort button is clicked", async () => {
    const user = userEvent.setup();
    const { onSortByChange } = renderResults();

    await user.click(screen.getByText("stations.sortDetour"));
    expect(onSortByChange).toHaveBeenCalledWith("detour");

    await user.click(screen.getByText("stations.sortKm"));
    expect(onSortByChange).toHaveBeenCalledWith("km");
  });

  it("fires onDetourBasisChange when the detour-basis toggle is clicked", async () => {
    const user = userEvent.setup();
    const { onDetourBasisChange } = renderResults();

    await user.click(screen.getByText("stations.basisAny"));
    expect(onDetourBasisChange).toHaveBeenCalledWith("any");
  });

  it("labels each row's difference from the average with its unit", () => {
    renderResults({ avgPrice: 1.555 });
    // Repsol 1.499 is 0.056 under the 1.555 average; Cepsa 1.612 is 0.057 over.
    const cheaper = screen.getByText("Repsol").closest("button")!;
    expect(cheaper).toHaveTextContent("\u22120.056 €/L stations.vsAvg");
    const dearer = screen.getByText("Cepsa").closest("button")!;
    expect(dearer).toHaveTextContent("+0.057 €/L stations.vsAvg");
  });

  it("names the detour and radius sliders and gives them a 24 px hit area", () => {
    renderResults();
    const detour = screen.getByRole("slider", { name: "stations.detourMax" });
    const radius = screen.getByRole("slider", { name: "stations.corridor" });
    expect(detour).toHaveClass("h-6");
    expect(radius).toHaveClass("h-6");
  });

  it("makes the sort and basis chips at least 32 px tall", () => {
    renderResults();
    for (const label of ["stations.sortPrice", "stations.sortDetour", "stations.sortKm", "stations.basisRoute", "stations.basisAny"]) {
      expect(screen.getByText(label)).toHaveClass("min-h-8");
    }
  });

  it("puts the savings figure on its own line, not beside km and detour", () => {
    renderResults({ avgPrice: 1.555 });
    const row = screen.getByText("Repsol").closest("button")!;
    const savings = within(row).getByText(/stations\.vsAvg/, { selector: "div" });
    // Its own block under the price, so the right column stays narrow and
    // the station name keeps its room.
    expect(savings).not.toHaveTextContent("km");
    expect(savings.parentElement).toHaveClass("shrink-0");
    expect(within(row).getByText(/^km \d+$/).parentElement).not.toHaveTextContent("stations.vsAvg");
  });
});
