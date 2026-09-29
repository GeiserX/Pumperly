import { describe, it, expect } from "vitest";
import { DEFAULT_EV, DEFAULT_VEHICLE, chargeKw, isPlannableFuel, minutesPerPct, readEvProfile, readVehicleProfile } from "./vehicle-profile";

describe("readVehicleProfile", () => {
  it("returns defaults for missing or corrupt storage", () => {
    expect(readVehicleProfile(null)).toEqual(DEFAULT_VEHICLE);
    expect(readVehicleProfile("{not json")).toEqual(DEFAULT_VEHICLE);
    expect(readVehicleProfile(JSON.stringify({ tankL: -1, consumptionL100: 6 }))).toEqual(DEFAULT_VEHICLE);
  });

  it("returns a valid stored profile", () => {
    expect(readVehicleProfile(JSON.stringify({ tankL: 60, consumptionL100: 5.2 }))).toEqual({ tankL: 60, consumptionL100: 5.2 });
  });
});

describe("readEvProfile", () => {
  it("returns defaults for missing, corrupt or fuel-shaped storage", () => {
    expect(readEvProfile(null)).toEqual(DEFAULT_EV);
    expect(readEvProfile("{not json")).toEqual(DEFAULT_EV);
    expect(readEvProfile(JSON.stringify({ tankL: 60, consumptionL100: 5.2 }))).toEqual(DEFAULT_EV);
    expect(readEvProfile(JSON.stringify({ batteryKwh: 5, consumptionKwh100: 18, maxChargeKw: 150 }))).toEqual(DEFAULT_EV);
  });

  it("keeps a profile saved before maxChargeKw existed, adding the default", () => {
    expect(readEvProfile(JSON.stringify({ batteryKwh: 77, consumptionKwh100: 16.5 }))).toEqual({
      batteryKwh: 77,
      consumptionKwh100: 16.5,
      maxChargeKw: 150,
    });
  });

  it("returns a valid stored profile", () => {
    const p = { batteryKwh: 77, consumptionKwh100: 16.5, maxChargeKw: 135 };
    expect(readEvProfile(JSON.stringify(p))).toEqual(p);
  });
});

describe("chargeKw", () => {
  it("assumes a slow charger when power is unknown", () => {
    expect(chargeKw(null, 150)).toBe(11);
    expect(chargeKw(undefined, 150)).toBe(11);
    expect(chargeKw(0, 150)).toBe(11);
  });

  it("limits AC posts to the car's onboard charger", () => {
    expect(chargeKw(7, 150)).toBe(7);
    expect(chargeKw(22, 150)).toBe(11);
  });

  it("averages DC over the taper, limited by car or station", () => {
    expect(chargeKw(50, 150)).toBeCloseTo(37.5);
    expect(chargeKw(350, 150)).toBeCloseTo(112.5);
  });
});

describe("minutesPerPct", () => {
  it("is the time to add 1 % of the battery", () => {
    // 0.6 kWh at 112.5 kW average = 0.32 min.
    expect(minutesPerPct(DEFAULT_EV, 350)).toBeCloseTo(0.32);
    // 0.6 kWh at 11 kW ≈ 3.27 min: 60 % takes over 3 h.
    expect(minutesPerPct(DEFAULT_EV, null)).toBeCloseTo(3.273, 2);
  });
});

describe("isPlannableFuel", () => {
  it("accepts per-litre fuels", () => {
    expect(isPlannableFuel("B7")).toBe(true);
    expect(isPlannableFuel("E5")).toBe(true);
    expect(isPlannableFuel("LPG")).toBe(true);
  });

  it("accepts EV (planned by energy)", () => {
    expect(isPlannableFuel("EV")).toBe(true);
  });

  it("rejects per-kg fuels and AdBlue", () => {
    expect(isPlannableFuel("CNG")).toBe(false);
    expect(isPlannableFuel("H2")).toBe(false);
    expect(isPlannableFuel("ADBLUE")).toBe(false);
  });
});
