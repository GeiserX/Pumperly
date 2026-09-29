import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { StationGeoJSON } from "@/types/station";

vi.mock("@/lib/i18n", () => ({
  useI18n: () => ({ t: (k: string) => k }),
}));

// Display currency and its rate per EUR; tests may switch to HUF.
const currencyState = { currency: "EUR", symbol: "€", decimals: 3, rate: 1 };
vi.mock("@/lib/currency", () => ({
  useCurrency: () => ({
    ...currencyState,
    formatPrice: (p: number) => p.toFixed(currencyState.decimals),
    convert: (p: number, from: string) => (from === currencyState.currency ? p : p * currencyState.rate),
  }),
}));

import { RefuelPlanner } from "./refuel-planner";

function makeStation(id: string, overrides: Partial<StationGeoJSON["properties"]> = {}): StationGeoJSON {
  return {
    type: "Feature",
    geometry: { type: "Point", coordinates: [-3.7, 40.4] },
    properties: {
      id,
      name: `Station ${id}`,
      brand: `Brand ${id}`,
      address: "Addr",
      city: "City",
      price: 1.5,
      reportedAt: null,
      fuelType: "B7",
      currency: "EUR",
      routeFraction: 0.5,
      detourMin: 2,
      ...overrides,
    },
  };
}

// 400 km route; default profile (50 L, 6.5 L/100) at 50 % can't make it without a stop.
const STATIONS = [
  makeStation("a", { brand: "Repsol", price: 1.4, routeFraction: 0.25 }),
  makeStation("b", { brand: "Cepsa", price: 1.6, routeFraction: 0.5 }),
];

function renderPlanner(props: Partial<React.ComponentProps<typeof RefuelPlanner>> = {}) {
  const onPlanChange = vi.fn();
  const onStopSelect = vi.fn();
  render(
    <RefuelPlanner
      stations={STATIONS}
      routeKm={400}
      onStopSelect={onStopSelect}
      onStopToggleOff={vi.fn()}
      onPlanChange={onPlanChange}
      {...props}
    />,
  );
  return { onPlanChange, onStopSelect };
}

describe("RefuelPlanner", () => {
  beforeEach(() => {
    localStorage.clear();
    Object.assign(currencyState, { currency: "EUR", symbol: "€", decimals: 3, rate: 1 });
  });

  it("is collapsed by default and reports no stops", () => {
    const { onPlanChange } = renderPlanner();
    expect(screen.queryByText("planner.tank")).not.toBeInTheDocument();
    expect(onPlanChange).toHaveBeenLastCalledWith([]);
  });

  it("recommends the cheaper station and reports it for the map", async () => {
    const { onPlanChange, onStopSelect } = renderPlanner();
    await userEvent.click(screen.getByText("planner.title"));
    expect(screen.getByText("Repsol")).toBeInTheDocument();
    expect(screen.queryByText("Cepsa")).not.toBeInTheDocument();
    expect(onPlanChange).toHaveBeenLastCalledWith([{ id: "a", coordinates: [-3.7, 40.4] }]);

    await userEvent.click(screen.getByText("Repsol"));
    expect(onStopSelect).toHaveBeenCalledWith([-3.7, 40.4], "a");
  });

  it("says no stop is needed when the start level covers the trip", async () => {
    renderPlanner();
    await userEvent.click(screen.getByText("planner.title"));
    fireEvent.change(screen.getByLabelText("planner.start"), { target: { value: "100" } });
    expect(screen.getByText("planner.noStop")).toBeInTheDocument();
  });

  it("waits for detours before planning", async () => {
    renderPlanner({ detoursLoading: true });
    await userEvent.click(screen.getByText("planner.title"));
    expect(screen.getByText("planner.calculating")).toBeInTheDocument();
  });

  it("keeps the time value in EUR and converts it to the display currency", async () => {
    Object.assign(currencyState, { currency: "HUF", symbol: "Ft", decimals: 0, rate: 390 });
    // Cheap but 60 min away vs. dearer at 1 min: at €15/h (5850 Ft/h) the detour isn't worth it.
    const { onPlanChange } = renderPlanner({
      stations: [
        makeStation("near", { brand: "Near", price: 632, currency: "HUF", routeFraction: 0.25, detourMin: 1 }),
        makeStation("far", { brand: "Far", price: 561, currency: "HUF", routeFraction: 0.25, detourMin: 60 }),
      ],
    });
    await userEvent.click(screen.getByText("planner.title"));
    expect(screen.getByDisplayValue("5850")).toBeInTheDocument();
    expect(onPlanChange).toHaveBeenLastCalledWith([{ id: "near", coordinates: [-3.7, 40.4] }]);
  });

  it("persists the vehicle profile", async () => {
    renderPlanner();
    await userEvent.click(screen.getByText("planner.title"));
    const tank = screen.getByLabelText("planner.tank");
    await userEvent.clear(tank);
    await userEvent.type(tank, "70");
    expect(JSON.parse(localStorage.getItem("pumperly-vehicle")!)).toEqual({ tankL: 70, consumptionL100: 6.5 });
  });
});
