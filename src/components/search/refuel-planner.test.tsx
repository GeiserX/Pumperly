import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
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

import { RefuelPlanner, DEFAULT_PLANNER_SETTINGS } from "./refuel-planner";

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

type PlannerProps = React.ComponentProps<typeof RefuelPlanner>;

// Owns the settings like SearchPanel does; `mounted` mimics the corridor refetch unmounting the planner.
function Harness({ mounted = true, ...props }: Omit<PlannerProps, "settings" | "onSettingsChange"> & { mounted?: boolean }) {
  const [settings, setSettings] = useState(DEFAULT_PLANNER_SETTINGS);
  return mounted ? <RefuelPlanner {...props} settings={settings} onSettingsChange={setSettings} /> : null;
}

function renderPlanner(props: Partial<React.ComponentProps<typeof Harness>> = {}) {
  const onPlanChange = vi.fn();
  const onStopSelect = vi.fn();
  const all = {
    stations: STATIONS,
    routeKm: 400,
    onStopSelect,
    onStopToggleOff: vi.fn(),
    onPlanChange,
    ...props,
  };
  const { rerender } = render(<Harness {...all} />);
  const setMounted = (mounted: boolean) => rerender(<Harness {...all} mounted={mounted} />);
  return { onPlanChange, onStopSelect, setMounted };
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

  it("only recommends stations that pass the map's price and detour filters", async () => {
    const stations = [
      makeStation("near", { brand: "Near", price: 1.6, routeFraction: 0.25, detourMin: 1 }),
      makeStation("far", { brand: "Far", price: 1.2, routeFraction: 0.25, detourMin: 12 }),
    ];
    const { onPlanChange } = renderPlanner({ stations, maxDetour: 5 });
    await userEvent.click(screen.getByText("planner.title"));
    expect(onPlanChange).toHaveBeenLastCalledWith([{ id: "near", coordinates: [-3.7, 40.4] }]);
  });

  it("drops stations above the price filter", async () => {
    const stations = [makeStation("b", { brand: "Cepsa", price: 1.6, routeFraction: 0.5 })];
    const { onPlanChange } = renderPlanner({ stations, maxPrice: 1.5 });
    await userEvent.click(screen.getByText("planner.title"));
    expect(screen.queryByText("Cepsa")).not.toBeInTheDocument();
    expect(onPlanChange).toHaveBeenLastCalledWith([]);
  });

  it("keeps its settings when it unmounts and comes back", async () => {
    const { setMounted } = renderPlanner();
    await userEvent.click(screen.getByText("planner.title"));
    fireEvent.change(screen.getByLabelText("planner.start"), { target: { value: "80" } });
    fireEvent.change(screen.getByLabelText("planner.reserve"), { target: { value: "15" } });

    setMounted(false);
    setMounted(true);

    expect(screen.getByLabelText("planner.start")).toHaveValue("80");
    expect(screen.getByLabelText("planner.reserve")).toHaveValue("15");
  });

  it("names the cause when no plan is possible", async () => {
    // Every station is over the price cap: nothing to plan with.
    renderPlanner({ maxPrice: 1.0 });
    await userEvent.click(screen.getByText("planner.title"));
    expect(screen.getByText("planner.infeasibleNoCandidates")).toBeInTheDocument();

  });

  it("blames the arrival level when the destination is reachable but not with that much left", async () => {
    renderPlanner();
    await userEvent.click(screen.getByText("planner.title"));
    fireEvent.change(screen.getByLabelText("planner.start"), { target: { value: "100" } });
    fireEvent.change(screen.getByLabelText("planner.arrival"), { target: { value: "100" } });
    expect(screen.getByText("planner.infeasibleArrival")).toBeInTheDocument();
  });

  it("plans a trip that needs more than three stops", async () => {
    // 4,000 km with a station every 40 km: the default car (50 L at 6.5 L/100 km)
    // needs five stops, more than a fixed cap of three would allow.
    const stations = Array.from({ length: 99 }, (_, i) =>
      makeStation(`s${i}`, { brand: `B${i}`, routeFraction: ((i + 1) * 40) / 4000, detourMin: 1 }),
    );
    const { onPlanChange } = renderPlanner({ stations, routeKm: 4000 });
    await userEvent.click(screen.getByText("planner.title"));
    fireEvent.change(screen.getByLabelText("planner.start"), { target: { value: "100" } });
    expect(onPlanChange.mock.lastCall![0].length).toBeGreaterThan(3);
  });

  it("persists the vehicle profile", async () => {
    renderPlanner();
    await userEvent.click(screen.getByText("planner.title"));
    const tank = screen.getByLabelText("planner.tank");
    await userEvent.clear(tank);
    await userEvent.type(tank, "70");
    // Nothing is saved mid-edit ("7" would be rejected, but "70" isn't committed yet either).
    expect(localStorage.getItem("pumperly-vehicle")).toBe(JSON.stringify({ tankL: 50, consumptionL100: 6.5 }));
    await userEvent.tab();
    expect(JSON.parse(localStorage.getItem("pumperly-vehicle")!)).toEqual({ tankL: 70, consumptionL100: 6.5 });
  });

  it("commits on Enter", async () => {
    renderPlanner();
    await userEvent.click(screen.getByText("planner.title"));
    const cons = screen.getByLabelText("planner.consumption");
    await userEvent.clear(cons);
    await userEvent.type(cons, "7.5{Enter}");
    expect(JSON.parse(localStorage.getItem("pumperly-vehicle")!)).toEqual({ tankL: 50, consumptionL100: 7.5 });
  });

  it("reverts an out-of-range value instead of saving a prefix of it", async () => {
    renderPlanner();
    await userEvent.click(screen.getByText("planner.title"));
    const tank = screen.getByLabelText("planner.tank");
    await userEvent.clear(tank);
    await userEvent.type(tank, "800");
    await userEvent.tab();
    expect(tank).toHaveValue(50);
    expect(JSON.parse(localStorage.getItem("pumperly-vehicle")!)).toEqual({ tankL: 50, consumptionL100: 6.5 });
  });
});
