import { describe, it, expect } from "vitest";
import { bareFuel, parseFuel, resolveInitialFuel, FUEL_COOKIE } from "./fuel-preference";

describe("fuel preference", () => {
  it("names the cookie the server and client share", () => {
    expect(FUEL_COOKIE).toBe("pumperly-fuel");
  });

  it("parses only known fuel codes", () => {
    expect(parseFuel("E10")).toBe("E10");
    expect(parseFuel("XX")).toBeNull();
    expect(parseFuel(undefined)).toBeNull();
    expect(parseFuel(null)).toBeNull();
  });

  it("reads a bare ?fuel= as the user's choice", () => {
    expect(bareFuel(new URLSearchParams("fuel=E5"))).toBe("E5");
  });

  it("ignores the fuel of a route link", () => {
    expect(bareFuel(new URLSearchParams("from=40.4,-3.7&to=39.4,-0.3&fuel=E5"))).toBeNull();
  });

  it("ignores the fuel of a station link", () => {
    expect(bareFuel(new URLSearchParams("station=ES:1&lat=40.4&lng=-3.7&fuel=E5"))).toBeNull();
  });

  it("ignores an unknown fuel code", () => {
    expect(bareFuel(new URLSearchParams("fuel=XX"))).toBeNull();
    expect(bareFuel(new URLSearchParams(""))).toBeNull();
  });

  it("picks link > bare > cookie > default", () => {
    const all = { linkFuel: "B7", bareFuel: "E5", cookieFuel: "E10", defaultFuel: "LPG" } as const;
    expect(resolveInitialFuel(all)).toBe("B7");
    expect(resolveInitialFuel({ ...all, linkFuel: null })).toBe("E5");
    expect(resolveInitialFuel({ ...all, linkFuel: null, bareFuel: null })).toBe("E10");
    expect(resolveInitialFuel({ linkFuel: null, bareFuel: null, cookieFuel: null, defaultFuel: "LPG" })).toBe("LPG");
  });
});
