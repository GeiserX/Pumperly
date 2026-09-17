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
  // What `--country=all` produces: both German sources are registered.
  const ALL = ["DE", "FR", "EV_DE", "EV_FR", "EV_DE_BNETZA", "EV_US"];

  it("uses BNetzA for Germany by default", () => {
    expect(resolveGermanyEvSource(SCHEDULED)).toContain("EV_DE_BNETZA");
    expect(resolveGermanyEvSource(SCHEDULED)).not.toContain("EV_DE");
  });

  it("keeps OpenChargeMap when PUMPERLY_DE_EV_SOURCE=ocm", () => {
    vi.stubEnv("PUMPERLY_DE_EV_SOURCE", "ocm");
    expect(resolveGermanyEvSource(SCHEDULED)).toContain("EV_DE");
    expect(resolveGermanyEvSource(SCHEDULED)).not.toContain("EV_DE_BNETZA");
  });

  it("is case- and whitespace-insensitive about the opt-out", () => {
    vi.stubEnv("PUMPERLY_DE_EV_SOURCE", "  OCM  ");
    expect(resolveGermanyEvSource(SCHEDULED)).toContain("EV_DE");
  });

  it("falls back to BNetzA when the override is not a source it knows", () => {
    vi.stubEnv("PUMPERLY_DE_EV_SOURCE", "nonsense");
    expect(resolveGermanyEvSource(SCHEDULED)).toContain("EV_DE_BNETZA");
  });

  it("collapses --country=all down to one German EV source", () => {
    for (const source of ["ocm", ""]) {
      vi.stubEnv("PUMPERLY_DE_EV_SOURCE", source);
      const out = resolveGermanyEvSource(ALL);
      expect(out.filter((c) => c === "EV_DE" || c === "EV_DE_BNETZA")).toHaveLength(1);
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
