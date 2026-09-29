import { describe, it, expect } from "vitest";
import { maxStopsFor, planRefuel, pruneCandidates, type PlannerInput, type PlannerStation } from "./refuel-planner";

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
    expect(planRefuel({ ...input, maxStops: 1 })).toMatchObject({ status: "infeasible", reason: "stops" });
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

  it("counts the way back from a station's detour when measuring reach", () => {
    // A 60 min detour is 50 km: 25 km back to the route before a full tank's 450 km
    // (down to the 10 % reserve) starts counting, so the car gets to km 525 of 540.
    const r = planRefuel({
      ...base,
      startPct: 50,
      arrivalPct: 0,
      reservePct: 10,
      routeKm: 540,
      stations: [st("A", 100, 1.5, 60)],
    });
    expect(r.status).toBe("infeasible");
    expect(r.reason).toBe("range");
    expect(r.gapKm).toBeCloseTo(525);
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

  it("blames the reserve when it, not the arrival level, is what can't be met", () => {
    // 20 km from 10 % arrives with 6 %: above the 0 % arrival level, under the 10 % reserve.
    const r = planRefuel({ ...base, startPct: 10, arrivalPct: 0, reservePct: 10, routeKm: 20, stations: [] });
    expect(r.status).toBe("infeasible");
    expect(r.reason).toBe("reserve");
  });

  it("says the stop cap is the problem when more stops would make it", () => {
    const stations = Array.from({ length: 11 }, (_, i) => st(`S${i}`, (i + 1) * 100, 1.5));
    const r = planRefuel({ ...base, startPct: 100, routeKm: 1200, stations, maxStops: 1 });
    expect(r.status).toBe("infeasible");
    expect(r.reason).toBe("stops");
    // A gap no number of stops can bridge is still a range problem.
    const gap = planRefuel({ ...base, startPct: 100, routeKm: 1200, stations: [st("A", 100, 1.5)], maxStops: 5 });
    expect(gap.reason).toBe("range");
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

  it("never becomes infeasible when the start level rises", () => {
    // Reserve 10 %, one station at km 20 (4 % away): start 10 may dip to 5 %, so
    // start 11 must not be refused just because it is above the reserve.
    let feasibleBefore = false;
    for (let start = 1; start <= 100; start++) {
      const r = planRefuel({ ...base, startPct: start, routeKm: 400, stations: [st("A", 20, 1.5)] });
      const feasible = r.status !== "infeasible";
      if (feasibleBefore) expect({ start, feasible }).toEqual({ start, feasible: true });
      feasibleBefore ||= feasible;
    }
    expect(feasibleBefore).toBe(true);
  });

  it("flags a plan that dips below the reserve on the first leg, and only that one", () => {
    const at = (startPct: number) => planRefuel({ ...base, startPct, routeKm: 400, stations: [st("A", 20, 1.5)] });
    const dipping = at(11);
    expect(dipping.status).toBe("ok");
    expect(dipping.dipsBelowReserve).toBe(true);
    expect(dipping.stops[0].arrivePct).toBeCloseTo(7);
    // 14 % reaches km 20 with exactly the reserve left: the strict plan exists and wins.
    expect(at(14).status).toBe("ok");
    expect(at(14).dipsBelowReserve).toBeUndefined();
    // At or below the reserve the half-start rule is the normal one, not a fallback.
    expect(at(10).status).toBe("ok");
    expect(at(10).dipsBelowReserve).toBeUndefined();
  });

  it("ignores stations with unknown detour or a negative price", () => {
    const r = planRefuel({
      ...base,
      startPct: 30,
      routeKm: 400,
      stations: [st("bad", 100, 1.0, -1), st("neg", 100, -1), st("ok", 100, 1.5)],
    });
    expect(r.stops.map((s) => s.id)).toEqual(["ok"]);
  });

  it("accepts a zero price (EV chargers are planned by energy only)", () => {
    const r = planRefuel({ ...base, startPct: 30, routeKm: 400, stations: [st("free", 100, 0)] });
    expect(r.stops.map((s) => s.id)).toEqual(["free"]);
  });

  it("ignores stations with a non-finite price, detour or km", () => {
    const r = planRefuel({
      ...base,
      startPct: 30,
      routeKm: 400,
      stations: [
        st("nanPrice", 100, Number.NaN),
        st("infPrice", 100, Infinity),
        st("nanDetour", 100, 0.5, Number.NaN),
        st("infDetour", 100, 0.5, Infinity),
        st("nanKm", Number.NaN, 0.5),
        st("ok", 100, 1.5),
      ],
    });
    expect(r.status).toBe("ok");
    expect(r.stops.map((s) => s.id)).toEqual(["ok"]);
    expect(Number.isFinite(r.totalFuelCost)).toBe(true);
    // Stations with an infinite price or detour are not candidates at all.
    const none = planRefuel({ ...base, routeKm: 600, stations: [st("infPrice", 100, Infinity), st("infDetour", 100, 1.5, Infinity)] });
    expect(none.reason).toBe("no-candidates");
  });

  it("keeps only the first station with a given id", () => {
    const r = planRefuel({
      ...base,
      startPct: 30,
      routeKm: 400,
      stations: [st("A", 100, 1.5), st("A", 90, 0.5), st("B", 80, 1.6)],
    });
    expect(r.stops.map((s) => [s.id, s.km])).toEqual([["A", 100]]);
    expect(r.totalFuelCost).toBeCloseTo(52.5);
  });

  it("treats a non-finite or negative value of time as zero", () => {
    const input = { ...base, startPct: 40, routeKm: 400, stations: [st("A", 100, 1.0, 60), st("B", 100, 1.5, 0)] };
    const free = planRefuel({ ...input, timeValuePerHour: 0 });
    for (const v of [Number.NaN, Infinity, -30]) {
      const r = planRefuel({ ...input, timeValuePerHour: v });
      expect(r.stops.map((s) => s.id)).toEqual(free.stops.map((s) => s.id));
      expect(r.totalFuelCost).toBeCloseTo(free.totalFuelCost);
    }
  });

  it("refuses a vehicle with no usable tank or consumption instead of returning NaN", () => {
    for (const bad of [{ tankL: 0 }, { tankL: Number.NaN }, { consumptionL100: Infinity }, { consumptionL100: -1 }]) {
      const r = planRefuel({ ...base, ...bad, routeKm: 400, stations: [st("A", 100, 1.5)] });
      expect(r.status).toBe("infeasible");
      expect(r.gapKm).toBe(0);
    }
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

  it("keeps the station needed to leave a bucket", () => {
    // From 72 % the tank reaches km 310. "early" is the cheapest, closest and first
    // station of its stretch, but from it a full tank ends at km 748, short of 755;
    // only "late" (10 km on) can carry the car to the destination.
    const early = st("early", 298, 1.4, 0);
    const late = st("late", 308.5, 1.9, 2);
    const fillers = Array.from({ length: 250 }, (_, i) => st(`F${i}`, i * 0.01, 2.5, 1));
    const input = { ...base, startPct: 72, arrivalPct: 10, reservePct: 10, routeKm: 755 };
    const unpruned = planRefuel({ ...input, stations: [early, late] });
    const pruned = planRefuel({ ...input, stations: [...fillers, early, late] });
    expect(unpruned.status).toBe("ok");
    expect(pruned.status).toBe("ok");
    expect(pruned.stops.map((s) => s.id)).toEqual(["early", "late"]);
    expect(pruned.stops.map((s) => s.id)).toEqual(unpruned.stops.map((s) => s.id));
    expect(pruned.totalFuelCost).toBeCloseTo(unpruned.totalFuelCost);
  });

  it("does not make a long plan much dearer by pruning the far-reaching station", () => {
    // "early" and "late" share a route bucket. From early a full tank ends at km 748,
    // so the plan must pay the dear X at km 700; from late it reaches the cheap C at km 760.
    const route = [
      st("early", 301, 1.4),
      st("late", 317, 1.45),
      st("X", 700, 2.4),
      st("C", 760, 1.2),
      st("D", 1150, 1.3),
    ];
    const fillers = Array.from({ length: 250 }, (_, i) => st(`F${i}`, i * 0.01, 2.5, 1));
    const input = { ...base, startPct: 75, arrivalPct: 10, reservePct: 10, routeKm: 1500 };
    expect(pruneCandidates([...fillers, ...route], 1500).map((s) => s.id)).toEqual(expect.arrayContaining(["early", "late"]));
    const unpruned = planRefuel({ ...input, stations: route });
    const pruned = planRefuel({ ...input, stations: [...fillers, ...route] });
    expect(unpruned.status).toBe("ok");
    expect(pruned.status).toBe("ok");
    expect(pruned.totalFuelCost).toBeLessThanOrEqual(unpruned.totalFuelCost * 1.01);
  });

  it("stays within the cap with four stations kept per bucket", () => {
    const stations = Array.from({ length: 5000 }, (_, i) => st(`S${i}`, i / 5, 1 + ((i * 7) % 13) / 10, (i * 3) % 11));
    expect(pruneCandidates(stations, 1000, 200).length).toBeLessThanOrEqual(200);
    expect(pruneCandidates(stations, 1000, 7).length).toBeLessThanOrEqual(7);
  });

  it("returns the input untouched under the cap", () => {
    const stations = [st("A", 1, 1), st("B", 2, 1)];
    expect(pruneCandidates(stations, 10, 200)).toBe(stations);
  });
});

describe("maxStopsFor", () => {
  it("allows the full tanks the trip needs plus two", () => {
    // 50 L at 10 L/100 km with a 10 % reserve: 450 km per tank.
    expect(maxStopsFor(2400, 50, 10, 10)).toBe(8);
    expect(maxStopsFor(900, 50, 10, 10)).toBe(4);
  });

  it("stays within 3 and 10", () => {
    expect(maxStopsFor(100, 50, 10, 10)).toBe(3);
    expect(maxStopsFor(20000, 50, 10, 10)).toBe(10);
    expect(maxStopsFor(500, 50, 10, 100)).toBe(10);
    expect(maxStopsFor(500, Number.NaN, 10, 10)).toBe(3);
  });

  it("lets a long trip with regular stations plan", () => {
    const stations = Array.from({ length: 59 }, (_, i) => st(`S${i}`, (i + 1) * 40, 1.4 + (i % 4) * 0.05));
    const input = { ...base, startPct: 100, routeKm: 2400, stations };
    expect(planRefuel({ ...input, maxStops: 3 }).reason).toBe("stops");
    const r = planRefuel({ ...input, maxStops: maxStopsFor(2400, base.tankL, base.consumptionL100, base.reservePct) });
    expect(r.status).toBe("ok");
    expect(r.stops.length).toBeGreaterThan(3);
  });
});

describe("planRefuel with maxChargePct (EV)", () => {
  // 60 kWh at 18 kWh/100 km: 0.3 % per km.
  const ev = { ...base, tankL: 60, consumptionL100: 18, startPct: 50 };

  it("never departs a stop above the cap", () => {
    const stations = [st("A", 90, 0), st("B", 180, 0)];
    const capped = planRefuel({ ...ev, routeKm: 300, stations, maxChargePct: 80 });
    expect(capped.status).toBe("ok");
    expect(capped.stops.map((s) => s.id)).toEqual(["A", "B"]);
    expect(Math.max(...capped.stops.map((s) => s.departPct))).toBeLessThanOrEqual(80);
    // Without the cap one stop at A (to 83 %) is enough.
    expect(planRefuel({ ...ev, routeKm: 300, stations }).stops.map((s) => s.id)).toEqual(["A"]);
  });

  it("with no price, adds only the energy needed", () => {
    const r = planRefuel({ ...ev, routeKm: 200, stations: [st("A", 90, 0)], maxChargePct: 80 });
    expect(r.status).toBe("ok");
    // Arrive 23 %, need 110 km × 0.3 + 20 = 53 %.
    expect(r.stops[0].departPct).toBe(53);
    expect(r.totalFuelCost).toBe(0);
  });

  it("reports stops when only a higher cap would do", () => {
    const r = planRefuel({ ...ev, routeKm: 300, stations: [st("A", 90, 0)], maxChargePct: 80 });
    expect(r.status).toBe("infeasible");
  });

  it("caps the stop estimate at the usable band", () => {
    expect(maxStopsFor(1000, 60, 18, 10, 80)).toBeGreaterThanOrEqual(maxStopsFor(1000, 60, 18, 10));
  });

  it("allows up to 20 stops under a charge cap, and treats a reserve above it as no range", () => {
    // 60 % usable of 60 kWh at 18 kWh/100 km = 200 km per leg.
    expect(maxStopsFor(2300, 60, 18, 20, 80)).toBe(14);
    expect(maxStopsFor(20000, 60, 18, 20, 80)).toBe(20);
    expect(maxStopsFor(500, 60, 18, 90, 80)).toBe(20);
    expect(maxStopsFor(20000, 60, 18, 20)).toBe(10);
  });

  it("plans a 2,300 km EV trip that needs more than 10 stops", () => {
    // A charger every 100 km; ~200 km per leg means about 11 stops.
    const trip = { ...ev, startPct: 80, arrivalPct: 20, reservePct: 20, routeKm: 2300, maxChargePct: 80 };
    const stations = Array.from({ length: 22 }, (_, i) => st(`C${i}`, (i + 1) * 100, 0));
    expect(planRefuel({ ...trip, stations, maxStops: 10 })).toMatchObject({ status: "infeasible", reason: "stops" });
    const r = planRefuel({ ...trip, stations, maxStops: maxStopsFor(2300, 60, 18, 20, 80) });
    expect(r.status).toBe("ok");
    expect(r.stops.length).toBeGreaterThan(10);
    expect(Math.max(...r.stops.map((s) => s.departPct))).toBeLessThanOrEqual(80);
    expect(Math.min(...r.stops.map((s) => s.arrivePct))).toBeGreaterThanOrEqual(20 - 1e-9);
  });
});
