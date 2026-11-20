import { describe, it, expect } from "vitest";
import { LOCALES, translations, type Locale } from "./i18n";
import { FUEL_TYPE_CODES, type FuelType } from "@/types/fuel";

describe("LOCALES", () => {
  it("is a non-empty array", () => {
    expect(LOCALES.length).toBeGreaterThan(0);
  });

  it("all entries have required fields", () => {
    for (const l of LOCALES) {
      expect(l.code).toBeTruthy();
      expect(l.label).toBeTruthy();
      expect(l.flag).toBeTruthy();
    }
  });

  it("all codes are 2-letter lowercase strings", () => {
    for (const l of LOCALES) {
      expect(l.code).toMatch(/^[a-z]{2}$/);
    }
  });

  it("all flags are 2-letter uppercase strings", () => {
    for (const l of LOCALES) {
      expect(l.flag).toMatch(/^[A-Z]{2}$/);
    }
  });

  it("has no duplicate codes", () => {
    const codes = LOCALES.map((l) => l.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it("includes es and en", () => {
    const codes = LOCALES.map((l) => l.code);
    expect(codes).toContain("es");
    expect(codes).toContain("en");
  });

  it("es is the first locale", () => {
    expect(LOCALES[0].code).toBe("es");
    expect(LOCALES[0].label).toBe("Espa\u00f1ol");
    expect(LOCALES[0].flag).toBe("ES");
  });

  it("has at least 10 locales", () => {
    expect(LOCALES.length).toBeGreaterThanOrEqual(10);
  });

  it("all labels are non-empty native language names", () => {
    for (const l of LOCALES) {
      expect(l.label.length).toBeGreaterThan(2);
    }
  });
});

describe("planner translations", () => {
  const plannerKeys = (locale: Locale) => Object.keys(translations[locale]).filter((k) => k.startsWith("planner.")).sort();

  it("every locale has the same planner keys", () => {
    const expected = plannerKeys("en");
    expect(expected).toEqual(expect.arrayContaining(["planner.noRates", "planner.infeasibleReserve", "planner.infeasibleStops", "planner.dipsReserve", "planner.noDetours"]));
    for (const { code } of LOCALES) expect({ code, keys: plannerKeys(code) }).toEqual({ code, keys: expected });
  });

  it("keeps the placeholders in every planner message", () => {
    for (const { code } of LOCALES) {
      for (const key of plannerKeys(code)) {
        const placeholders = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort();
        expect({ code, key, p: placeholders(translations[code][key]) }).toEqual({ code, key, p: placeholders(translations.en[key]) });
      }
    }
  });
});

describe("shared strings for the web fixes", () => {
  // The iOS app's fuel names (pumperly-ios Shared/Resources/{en,es}.lproj/Localizable.strings),
  // so the web map and the native settings name each fuel the same way.
  const NATIVE_FUEL_NAMES: Record<"en" | "es", Record<FuelType, string>> = {
    en: {
      B7: "Diesel",
      B7_PREMIUM: "Premium diesel",
      B10: "Diesel B10",
      B_AGRICULTURAL: "Agricultural diesel (B)",
      HVO: "Renewable diesel (HVO)",
      E5: "Petrol 95",
      E5_PREMIUM: "Premium petrol 95",
      E10: "Petrol 95 E10",
      E5_98: "Petrol 98",
      E98_E10: "Petrol 98 E10",
      LPG: "LPG / Autogas",
      CNG: "CNG",
      LNG: "LNG",
      H2: "Hydrogen",
      EV: "EV charging",
      ADBLUE: "AdBlue",
    },
    es: {
      B7: "Diésel A",
      B7_PREMIUM: "Diésel Premium",
      B10: "Diésel B10",
      B_AGRICULTURAL: "Diésel B (agrícola)",
      HVO: "Diésel renovable (HVO)",
      E5: "Gasolina 95",
      E5_PREMIUM: "Gasolina 95 Premium",
      E10: "Gasolina 95 E10",
      E5_98: "Gasolina 98",
      E98_E10: "Gasolina 98 E10",
      LPG: "GLP / Autogás",
      CNG: "GNC",
      LNG: "GNL",
      H2: "Hidrógeno",
      EV: "Carga eléctrica",
      ADBLUE: "AdBlue",
    },
  };

  const SHARED_KEYS = [
    "geo.deniedHelp",
    "geo.openSettings",
    "geo.unavailable",
    "common.close",
    "common.retry",
    "search.clearOrigin",
    "search.clearDestination",
    "search.removeWaypoint",
    "stations.cheapestSummary",
    "stations.vsAvg",
    "route.offline",
    "map.loading",
    "map.loadError",
    "map.noStationsHere",
    "currency.auto",
    "currency.label",
    "fuel.picker",
    ...FUEL_TYPE_CODES.map((code) => `fuel.${code}`),
  ];

  it("every locale has every shared key, non-empty", () => {
    expect(SHARED_KEYS).toHaveLength(33);
    for (const { code } of LOCALES) {
      const missing = SHARED_KEYS.filter((key) => !translations[code][key]?.trim());
      expect({ code, missing }).toEqual({ code, missing: [] });
    }
  });

  it("keeps the {name} and {price} placeholders in the cheapest summary", () => {
    for (const { code } of LOCALES) {
      const placeholders = (translations[code]["stations.cheapestSummary"]?.match(/\{\w+\}/g) ?? []).sort();
      expect({ code, placeholders }).toEqual({ code, placeholders: ["{name}", "{price}"] });
    }
  });

  it("names every fuel in English and Spanish exactly as the iOS app does", () => {
    for (const locale of ["en", "es"] as const) {
      for (const code of FUEL_TYPE_CODES) {
        expect({ locale, code, name: translations[locale][`fuel.${code}`] }).toEqual({ locale, code, name: NATIVE_FUEL_NAMES[locale][code] });
      }
    }
  });

  it("calls the English petrol category Petrol, like the iOS app", () => {
    expect(translations.en["fuel.gasoline"]).toBe("Petrol");
  });
});
