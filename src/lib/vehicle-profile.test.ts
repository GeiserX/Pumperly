import { describe, it, expect } from "vitest";
import { DEFAULT_EV, DEFAULT_VEHICLE, isPlannableFuel, readEvProfile, readVehicleProfile } from "./vehicle-profile";

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
    expect(readEvProfile(JSON.stringify({ batteryKwh: 5, consumptionKwh100: 18 }))).toEqual(DEFAULT_EV);
  });

  it("returns a valid stored profile", () => {
    expect(readEvProfile(JSON.stringify({ batteryKwh: 77, consumptionKwh100: 16.5 }))).toEqual({ batteryKwh: 77, consumptionKwh100: 16.5 });
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
