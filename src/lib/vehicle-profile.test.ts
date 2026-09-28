import { describe, it, expect } from "vitest";
import { DEFAULT_VEHICLE, isPlannableFuel, readVehicleProfile } from "./vehicle-profile";

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

describe("isPlannableFuel", () => {
  it("accepts per-litre fuels", () => {
    expect(isPlannableFuel("B7")).toBe(true);
    expect(isPlannableFuel("E5")).toBe(true);
    expect(isPlannableFuel("LPG")).toBe(true);
  });

  it("rejects per-kg fuels, EV and AdBlue", () => {
    expect(isPlannableFuel("CNG")).toBe(false);
    expect(isPlannableFuel("H2")).toBe(false);
    expect(isPlannableFuel("EV")).toBe(false);
    expect(isPlannableFuel("ADBLUE")).toBe(false);
  });
});
