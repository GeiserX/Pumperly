import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import type { StationGeoJSON } from "@/types/station";
import type { PlanResult } from "@/lib/refuel-planner";

// Pass-through spy: records what the component actually plans with; a test may
// set `planOverride.result` to render a given outcome.
const { planSpy, planOverride } = vi.hoisted(() => ({
  planSpy: vi.fn(),
  planOverride: { result: null as PlanResult | null },
}));
vi.mock("@/lib/refuel-planner", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/lib/refuel-planner")>();
  return {
    ...mod,
    planRefuel: (input: Parameters<typeof mod.planRefuel>[0]) => {
      planSpy(input);
      return planOverride.result ?? mod.planRefuel(input);
    },
  };
});

vi.mock("@/lib/i18n", () => ({
  useI18n: () => ({ t: (k: string) => k }),
}));

// Display currency and its rate per EUR; tests may switch to HUF. `rates` is the
// ECB table the context exposes (null until fetched).
const currencyState: {
  currency: string;
  symbol: string;
  decimals: number;
  rate: number;
  rates: { base: "EUR"; rates: Record<string, number>; date: string } | null;
} = { currency: "EUR", symbol: "€", decimals: 3, rate: 1, rates: null };
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
    planSpy.mockClear();
    planOverride.result = null;
    Object.assign(currencyState, { currency: "EUR", symbol: "€", decimals: 3, rate: 1, rates: null });
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

  it("announces the result and exposes slider and stop state to assistive tech", async () => {
    renderPlanner({ selectedStationId: "a" });
    await userEvent.click(screen.getByText("planner.title"));
    const status = screen.getByRole("status");
    expect(status).toHaveAttribute("aria-live", "polite");
    expect(status).toHaveTextContent("Repsol");
    expect(screen.getByLabelText("planner.start")).toHaveAttribute("aria-valuetext", "50%");
    expect(screen.getByLabelText("planner.reserve")).toHaveAttribute("aria-valuetext", "20%");
    expect(screen.getByRole("button", { name: /Repsol/, pressed: true })).toBeInTheDocument();
  });

  it("marks a stop that is not selected as not pressed", async () => {
    renderPlanner({ selectedStationId: null });
    await userEvent.click(screen.getByText("planner.title"));
    expect(screen.getByRole("button", { name: /Repsol/, pressed: false })).toBeInTheDocument();
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

  it("treats a corridor with no detour yet as loading, not as no candidates", async () => {
    const { onPlanChange } = renderPlanner({ stations: STATIONS.map((s) => ({ ...s, properties: { ...s.properties, detourMin: undefined } })) });
    await userEvent.click(screen.getByText("planner.title"));
    expect(screen.getByText("planner.calculating")).toBeInTheDocument();
    expect(screen.queryByText("planner.infeasibleNoCandidates")).not.toBeInTheDocument();
    expect(onPlanChange).toHaveBeenLastCalledWith([]);
  });

  it("keeps the time value in EUR and converts it to the display currency", async () => {
    Object.assign(currencyState, {
      currency: "HUF", symbol: "Ft", decimals: 0, rate: 390,
      rates: { base: "EUR", rates: { HUF: 390 }, date: "2026-09-28" },
    });
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

  it("does not plan or take a time value when the display currency has no rate", async () => {
    Object.assign(currencyState, { currency: "HUF", symbol: "Ft", decimals: 0, rate: 390, rates: null });
    const { onPlanChange } = renderPlanner({
      stations: [makeStation("near", { brand: "Near", price: 632, currency: "HUF", routeFraction: 0.25, detourMin: 1 })],
    });
    await userEvent.click(screen.getByText("planner.title"));
    expect(screen.getByText("planner.noRates")).toBeInTheDocument();
    expect(screen.getByLabelText("planner.timeValue")).toBeDisabled();
    expect(screen.queryByText("Near")).not.toBeInTheDocument();
    expect(onPlanChange).toHaveBeenLastCalledWith([]);
    // A rate table without this currency is no better.
    Object.assign(currencyState, { rates: { base: "EUR", rates: { USD: 1.1 }, date: "2026-09-28" } });
    fireEvent.change(screen.getByLabelText("planner.start"), { target: { value: "40" } });
    expect(screen.getByText("planner.noRates")).toBeInTheDocument();
  });

  it("edits the value of time like the vehicle fields and plans with what it shows", async () => {
    renderPlanner();
    await userEvent.click(screen.getByText("planner.title"));
    const field = screen.getByLabelText("planner.timeValue");
    const planned = () => planSpy.mock.lastCall![0].timeValuePerHour;
    expect(field).toHaveValue(15);
    expect(planned()).toBe(15);

    // Emptyable mid-edit, and nothing is planned from a half-typed value.
    await userEvent.clear(field);
    expect(field).toHaveValue(null);
    await userEvent.type(field, "2");
    expect(planned()).toBe(15);
    await userEvent.type(field, "0{Enter}");
    expect(field).toHaveValue(20);
    expect(planned()).toBe(20);

    // Invalid or empty input reverts to the saved value.
    await userEvent.clear(field);
    await userEvent.tab();
    expect(field).toHaveValue(20);
    expect(planned()).toBe(20);
  });

  it("shows the same converted value of time it plans with", async () => {
    Object.assign(currencyState, {
      currency: "HUF", symbol: "Ft", decimals: 0, rate: 390,
      rates: { base: "EUR", rates: { HUF: 390 }, date: "2026-09-28" },
    });
    renderPlanner({ stations: [makeStation("near", { price: 632, currency: "HUF", routeFraction: 0.25, detourMin: 1 })] });
    await userEvent.click(screen.getByText("planner.title"));
    const field = screen.getByLabelText("planner.timeValue");
    await userEvent.clear(field);
    await userEvent.type(field, "4321.6{Enter}");
    expect(field).toHaveValue(4322);
    expect(planSpy.mock.lastCall![0].timeValuePerHour).toBe(4322);
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

  it("blames the reserve when only the reserve can't be kept", async () => {
    // 20 km from 10 % arrives with about 7 %: the 0 % arrival is met, the 10 % reserve is not.
    renderPlanner({ routeKm: 20, maxPrice: 1.0 });
    await userEvent.click(screen.getByText("planner.title"));
    fireEvent.change(screen.getByLabelText("planner.start"), { target: { value: "10" } });
    fireEvent.change(screen.getByLabelText("planner.arrival"), { target: { value: "0" } });
    expect(screen.getByText("planner.infeasibleReserve")).toBeInTheDocument();
  });

  it("says when the trip needs more stops than the planner suggests", async () => {
    planOverride.result = { status: "infeasible", stops: [], totalFuelCost: 0, totalDetourMin: 0, endPct: 0, profile: [], gapKm: 300, reason: "stops" };
    renderPlanner();
    await userEvent.click(screen.getByText("planner.title"));
    expect(screen.getByText("planner.infeasibleStops")).toBeInTheDocument();
  });

  it("notes a plan that reaches the first stop below the reserve, and only that one", async () => {
    const stop = { id: "a", km: 100, litres: 30, cost: 42, detourMin: 2, arrivePct: 6, departPct: 66 };
    const ok: PlanResult = { status: "ok", stops: [stop], totalFuelCost: 42, totalDetourMin: 2, endPct: 20, profile: [] };
    planOverride.result = ok;
    renderPlanner();
    await userEvent.click(screen.getByText("planner.title"));
    expect(screen.getByText("Repsol")).toBeInTheDocument();
    expect(screen.queryByText("planner.dipsReserve")).not.toBeInTheDocument();
    planOverride.result = { ...ok, dipsBelowReserve: true };
    fireEvent.change(screen.getByLabelText("planner.start"), { target: { value: "11" } });
    expect(screen.getByText("planner.dipsReserve")).toBeInTheDocument();
  });

  it("blames the detour service, not the filters, when every detour failed", async () => {
    renderPlanner({ stations: STATIONS.map((s) => ({ ...s, properties: { ...s.properties, detourMin: -1 } })) });
    await userEvent.click(screen.getByText("planner.title"));
    expect(screen.getByText("planner.noDetours")).toBeInTheDocument();
    expect(screen.queryByText("planner.infeasibleNoCandidates")).not.toBeInTheDocument();
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

  describe("EV mode", () => {
    // 60 kWh at 18 kWh/100 km: 0.3 % per km. From 50 % over 300 km, one stop
    // capped at 80 % can't make it, so it takes both chargers.
    const CHARGERS = [
      makeStation("x", { brand: "Ionity", price: null, currency: undefined, fuelType: "EV", routeFraction: 0.3, detourMin: 0 }),
      makeStation("y", { brand: "Tesla", price: null, currency: undefined, fuelType: "EV", routeFraction: 0.6, detourMin: 0 }),
    ];

    it("plans price-less chargers by energy, capped at 80 %", async () => {
      const { onPlanChange } = renderPlanner({ mode: "ev", stations: CHARGERS, routeKm: 300 });
      await userEvent.click(screen.getByText("planner.titleEv"));
      expect(planSpy).toHaveBeenLastCalledWith(expect.objectContaining({ tankL: 60, consumptionL100: 18, maxChargePct: 80 }));
      expect(onPlanChange.mock.lastCall![0].map((s: { id: string }) => s.id)).toEqual(["x", "y"]);
      expect(screen.getByText("planner.tripEnergy")).toBeInTheDocument();
      expect(screen.getAllByText(/^\+\d+\.\d kWh$/)).toHaveLength(2);
    });

    it("shows battery fields, no value of time, and needs no exchange rates", async () => {
      currencyState.currency = "HUF";
      renderPlanner({ mode: "ev", stations: CHARGERS, routeKm: 300 });
      await userEvent.click(screen.getByText("planner.titleEv"));
      expect(screen.getByLabelText("planner.battery")).toHaveValue(60);
      expect(screen.getByLabelText("planner.consumptionEv")).toHaveValue(18);
      expect(screen.queryByText(/planner.timeValue/)).not.toBeInTheDocument();
      expect(screen.queryByText("planner.noRates")).not.toBeInTheDocument();
      expect(planSpy).toHaveBeenCalled();
    });

    it("persists the EV profile apart from the fuel one", async () => {
      renderPlanner({ mode: "ev", stations: CHARGERS, routeKm: 300 });
      await userEvent.click(screen.getByText("planner.titleEv"));
      const battery = screen.getByLabelText("planner.battery");
      await userEvent.clear(battery);
      await userEvent.type(battery, "77{Enter}");
      expect(JSON.parse(localStorage.getItem("pumperly-ev")!)).toEqual({ batteryKwh: 77, consumptionKwh100: 18 });
      expect(JSON.parse(localStorage.getItem("pumperly-vehicle")!)).toEqual({ tankL: 50, consumptionL100: 6.5 });
    });
  });
});
