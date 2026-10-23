import { describe, it, expect, afterEach, vi } from "vitest";
import { resolveGermanyEvSource } from "./germany-ev-source";

// The scheduler and the manual CLI both route Germany's EV scraping through
// this, so this is the test that stops them drifting apart. Drift is silent:
// the map just quietly refills with duplicate German chargers.

describe("resolveGermanyEvSource", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // What the scheduler produces once EV_XX codes are derived.
  const SCHEDULED = ["DE", "FR", "EV_DE", "EV_FR", "EV_US"];
  // What `--country=all` produces: every German source is registered.
  const ALL = ["DE", "FR", "EV_DE", "EV_FR", "EV_DE_BNETZA", "EV_DE_OCPDB", "EV_US"];
  const GERMAN = ["EV_DE", "EV_DE_BNETZA", "EV_DE_OCPDB"];
  const german = (codes: string[]) => codes.filter((c) => GERMAN.includes(c));

  it("uses OCPDB for Germany by default", () => {
    expect(german(resolveGermanyEvSource(SCHEDULED))).toEqual(["EV_DE_OCPDB"]);
  });

  it("uses BNetzA when PUMPERLY_DE_EV_SOURCE=bnetza", () => {
    vi.stubEnv("PUMPERLY_DE_EV_SOURCE", "bnetza");
    expect(german(resolveGermanyEvSource(SCHEDULED))).toEqual(["EV_DE_BNETZA"]);
  });

  it("keeps OpenChargeMap when PUMPERLY_DE_EV_SOURCE=ocm", () => {
    vi.stubEnv("PUMPERLY_DE_EV_SOURCE", "ocm");
    expect(german(resolveGermanyEvSource(SCHEDULED))).toEqual(["EV_DE"]);
  });

  it("is case- and whitespace-insensitive about the opt-out", () => {
    vi.stubEnv("PUMPERLY_DE_EV_SOURCE", "  OCM  ");
    expect(resolveGermanyEvSource(SCHEDULED)).toContain("EV_DE");
  });

  it("falls back to OCPDB when the override is not a source it knows", () => {
    for (const source of ["nonsense", "constructor", "toString"]) {
      vi.stubEnv("PUMPERLY_DE_EV_SOURCE", source);
      expect(german(resolveGermanyEvSource(SCHEDULED))).toEqual(["EV_DE_OCPDB"]);
    }
  });

  it("collapses --country=all down to one German EV source", () => {
    for (const source of ["ocm", "bnetza", "ocpdb", ""]) {
      vi.stubEnv("PUMPERLY_DE_EV_SOURCE", source);
      expect(german(resolveGermanyEvSource(ALL))).toHaveLength(1);
    }
  });

  it("leaves every other country untouched", () => {
    expect(resolveGermanyEvSource(ALL).filter((c) => !c.startsWith("EV_DE"))).toEqual([
      "DE",
      "FR",
      "EV_FR",
      "EV_US",
    ]);
  });

  it("adds nothing when Germany has no EV scraper enabled", () => {
    const fuelOnly = ["DE", "FR", "IT"];
    expect(resolveGermanyEvSource(fuelOnly)).toEqual(fuelOnly);
  });
});
