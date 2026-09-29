import { describe, it, expect } from "vitest";
import { planRefuel, pruneCandidates, type PlannerInput, type PlannerStation } from "./refuel-planner";

// 50 L tank at 10 L/100 km: 0.2 % per km, 500 km on a full tank.
const base: Omit<PlannerInput, "routeKm" | "stations"> = {
  tankL: 50,
  consumptionL100: 10,
  startPct: 50,
  arrivalPct: 20,
  reservePct: 10,
  timeValuePerHour: 0,
  maxStops: 3,
};

const st = (id: string, km: number, price: number, detourMin = 0): PlannerStation => ({ id, km, price, detourMin });

describe("planRefuel", () => {
  it("needs no stop when the start level covers the trip", () => {
    const r = planRefuel({ ...base, routeKm: 100, stations: [st("A", 50, 1.5)] });
    expect(r.status).toBe("no-stop-needed");
    expect(r.stops).toEqual([]);
    expect(r.endPct).toBeCloseTo(30);
  });

  it("makes a single forced stop and buys just enough", () => {
    const r = planRefuel({ ...base, startPct: 30, routeKm: 400, stations: [st("A", 100, 1.5)] });
    expect(r.status).toBe("ok");
    expect(r.stops).toHaveLength(1);
    const [s] = r.stops;
    expect(s.arrivePct).toBeCloseTo(10);
    expect(s.departPct).toBe(80);
    expect(s.litres).toBeCloseTo(35);
    expect(r.totalFuelCost).toBeCloseTo(52.5);
    expect(r.endPct).toBeCloseTo(20);
  });

  it("prefers the cheaper station when it is within range", () => {
    const r = planRefuel({
      ...base,
      startPct: 30,
      routeKm: 400,
      stations: [st("A", 50, 2.0), st("B", 100, 1.5)],
    });
    expect(r.stops.map((s) => s.id)).toEqual(["B"]);
  });

  it("skips a cheap station with a long detour when time is valuable", () => {
    const stations = [st("A", 100, 1.0, 60), st("B", 100, 1.5, 0)];
    // Start at 40 % so A's detour (≈50 km extra) still arrives above the reserve.
    const input = { ...base, startPct: 40, routeKm: 400, stations };
    expect(planRefuel({ ...input, timeValuePerHour: 30 }).stops.map((s) => s.id)).toEqual(["B"]);
    expect(planRefuel({ ...input, timeValuePerHour: 0 }).stops.map((s) => s.id)).toEqual(["A"]);
  });

  it("honours maxStops", () => {
    const stations = Array.from({ length: 11 }, (_, i) => st(`S${i}`, (i + 1) * 100, 1.5));
    const input = { ...base, startPct: 100, routeKm: 1200, stations };
    expect(planRefuel({ ...input, maxStops: 1 }).status).toBe("infeasible");
    const r = planRefuel({ ...input, maxStops: 3 });
    expect(r.status).toBe("ok");
    expect(r.stops.length).toBeGreaterThanOrEqual(2);
    expect(r.stops.length).toBeLessThanOrEqual(3);
  });

  it("never drops below the reserve and meets the arrival target", () => {
    const stations = Array.from({ length: 11 }, (_, i) => st(`S${i}`, (i + 1) * 100, 1.4 + (i % 3) * 0.1));
    const r = planRefuel({ ...base, startPct: 60, routeKm: 1200, stations });
    expect(r.status).toBe("ok");
    for (const p of r.profile) expect(p.pct).toBeGreaterThanOrEqual(10 - 1e-6);
    for (const p of r.profile) expect(p.pct).toBeLessThanOrEqual(100 + 1e-6);
    expect(r.endPct).toBeGreaterThanOrEqual(20 - 1e-6);
  });

  it("reports the furthest reachable km when infeasible", () => {
    const r = planRefuel({ ...base, routeKm: 600, stations: [st("A", 400, 1.5)] });
    expect(r.status).toBe("infeasible");
    expect(r.gapKm).toBeCloseTo(200);
    expect(r.reason).toBe("range");
  });

  it("says there are no candidates when no station is usable", () => {
    const r = planRefuel({ ...base, routeKm: 600, stations: [] });
    expect(r.status).toBe("infeasible");
    expect(r.reason).toBe("no-candidates");
  });

  it("blames the arrival target when the destination is reachable above the reserve", () => {
    // Full tank at km 100 still arrives with only 80 %.
    const r = planRefuel({ ...base, arrivalPct: 100, routeKm: 200, stations: [st("A", 100, 1.5)] });
    expect(r.status).toBe("infeasible");
    expect(r.reason).toBe("arrival");
    // No stations at all, but the start level alone reaches the destination above the reserve.
    expect(planRefuel({ ...base, routeKm: 200, stations: [] }).reason).toBe("arrival");
  });

  it("lets the first leg dip into the reserve when starting below it", () => {
    const r = planRefuel({ ...base, startPct: 5, routeKm: 300, stations: [st("A", 10, 1.5)] });
    expect(r.status).toBe("ok");
    expect(r.stops[0].arrivePct).toBeCloseTo(3);
  });

  it("can still reach a nearby station when starting exactly at the reserve", () => {
    const r = planRefuel({ ...base, startPct: 10, routeKm: 300, stations: [st("A", 20, 1.5)] });
    expect(r.status).toBe("ok");
    expect(r.stops[0].arrivePct).toBeCloseTo(6);
  });

  it("allows at most half the start level on the first leg when low", () => {
    // 10 % start → may drop to 5 % → 25 km reach; station at 30 km is out of range.
    const r = planRefuel({ ...base, startPct: 10, routeKm: 300, stations: [st("A", 30, 1.5)] });
    expect(r.status).toBe("infeasible");
    expect(r.gapKm).toBeCloseTo(25);
  });

  it("keeps the reserve on the first leg when starting above it", () => {
    // 15 % start, 10 % reserve: OK arrives at exactly 10 %, BELOW is cheaper but would arrive at 8 %.
    const r = planRefuel({ ...base, startPct: 15, routeKm: 300, stations: [st("OK", 25, 1.6), st("BELOW", 35, 1.5)] });
    expect(r.status).toBe("ok");
    expect(r.stops[0].id).toBe("OK");
    expect(r.stops[0].arrivePct).toBeCloseTo(10);
  });

  it("ignores stations with unknown detour or no price", () => {
    const r = planRefuel({
      ...base,
      startPct: 30,
      routeKm: 400,
      stations: [st("bad", 100, 1.0, -1), st("free", 100, 0), st("ok", 100, 1.5)],
    });
    expect(r.stops.map((s) => s.id)).toEqual(["ok"]);
  });
});

describe("pruneCandidates", () => {
  it("caps the candidate count and keeps km order", () => {
    const stations = Array.from({ length: 1000 }, (_, i) => st(`S${i}`, i, 1 + ((i * 7) % 13) / 10, (i * 3) % 11));
    const out = pruneCandidates(stations, 1000, 200);
    expect(out.length).toBeLessThanOrEqual(200);
    for (let i = 1; i < out.length; i++) expect(out[i].km).toBeGreaterThanOrEqual(out[i - 1].km);
  });

  it("keeps the only station a low tank can reach", () => {
    // 1 % start → first leg may drop to 0.5 % → 2.5 km of range. In the first
    // bucket only "reach" is in range; it is neither the cheapest nor the least detour.
    const stations = [
      st("reach", 0.5, 2.0, 2),
      st("cheap", 2.5, 1.0, 3),
      st("close", 3.0, 1.9, 0.5),
      ...Array.from({ length: 300 }, (_, i) => st(`F${i}`, 5 + i, 1.5, 1)),
    ];
    expect(pruneCandidates(stations, 310).map((s) => s.id)).toContain("reach");
    const r = planRefuel({ ...base, startPct: 1, routeKm: 310, stations });
    expect(r.status).toBe("ok");
    expect(r.stops[0].id).toBe("reach");
  });

  it("returns the input untouched under the cap", () => {
    const stations = [st("A", 1, 1), st("B", 2, 1)];
    expect(pruneCandidates(stations, 10, 200)).toBe(stations);
  });
});
