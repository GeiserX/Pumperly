// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createElement, type ReactNode } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { StationGeoJSON, StationsGeoJSONCollection } from "@/types/station";
import { CURRENCIES, CurrencyProvider, isValidExchangeRates, useConvertedStations, useCurrency, type Currency, type CurrencyInfo } from "./currency";

describe("CURRENCIES", () => {
  it("is a non-empty array", () => {
    expect(CURRENCIES.length).toBeGreaterThan(0);
  });

  it("all entries have required fields", () => {
    for (const c of CURRENCIES) {
      expect(c.code).toBeTruthy();
      expect(c.symbol).toBeTruthy();
      expect(c.label).toBeTruthy();
      expect(typeof c.decimals).toBe("number");
      expect(c.decimals).toBeGreaterThanOrEqual(0);
    }
  });

  it("has no duplicate codes", () => {
    const codes = CURRENCIES.map((c) => c.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it("all codes are 3-letter uppercase strings", () => {
    for (const c of CURRENCIES) {
      expect(c.code).toMatch(/^[A-Z]{3}$/);
    }
  });

  it("includes EUR as the first entry", () => {
    expect(CURRENCIES[0].code).toBe("EUR");
    expect(CURRENCIES[0].symbol).toBe("\u20ac");
  });

  it("includes major world currencies", () => {
    const codes = CURRENCIES.map((c) => c.code);
    expect(codes).toContain("EUR");
    expect(codes).toContain("USD");
    expect(codes).toContain("GBP");
    expect(codes).toContain("JPY");
    expect(codes).toContain("CHF");
    expect(codes).toContain("CAD");
  });

  it("decimals are between 0 and 3", () => {
    for (const c of CURRENCIES) {
      expect(c.decimals).toBeGreaterThanOrEqual(0);
      expect(c.decimals).toBeLessThanOrEqual(3);
    }
  });

  it("zero-decimal currencies have decimals=0", () => {
    const zeroDecimal = CURRENCIES.filter((c) =>
      ["JPY", "ISK", "HUF", "RSD", "MKD", "KRW", "IDR", "ARS"].includes(c.code),
    );
    for (const c of zeroDecimal) {
      expect(c.decimals, `${c.code} should have 0 decimals`).toBe(0);
    }
  });

  it("has at least 30 currencies", () => {
    expect(CURRENCIES.length).toBeGreaterThanOrEqual(30);
  });
});

describe("isValidExchangeRates", () => {
  it("accepts a well-formed payload", () => {
    expect(
      isValidExchangeRates({ base: "EUR", rates: { USD: 1.1 }, date: "2026-06-07" }),
    ).toBe(true);
  });

  it("rejects payload with missing date", () => {
    expect(isValidExchangeRates({ base: "EUR", rates: { USD: 1.1 } })).toBe(false);
  });

  it("rejects payload with non-string date", () => {
    expect(
      isValidExchangeRates({ base: "EUR", rates: { USD: 1.1 }, date: 12345 }),
    ).toBe(false);
  });

  it("rejects payload with missing rates object", () => {
    expect(isValidExchangeRates({ base: "EUR", date: "2026-06-07" })).toBe(false);
  });

  it("rejects payload with missing base", () => {
    expect(isValidExchangeRates({ rates: { USD: 1.1 }, date: "2026-06-07" })).toBe(false);
  });

  it("rejects null and non-object values", () => {
    expect(isValidExchangeRates(null)).toBe(false);
    expect(isValidExchangeRates(undefined)).toBe(false);
    expect(isValidExchangeRates("nope")).toBe(false);
  });
});

function station(id: string, price: number, currency: string): StationGeoJSON {
  return {
    type: "Feature",
    geometry: { type: "Point", coordinates: [0, 0] },
    properties: { id, name: `Station ${id}`, brand: null, address: "Street 1", city: "Town", price, reportedAt: null, fuelType: "B7", currency },
  };
}

const collection = (...features: StationGeoJSON[]): StationsGeoJSONCollection => ({ type: "FeatureCollection", features });

const EUR_VIEW = collection(station("A", 1.8, "EUR"), station("B", 1.75, "EUR"));
const CHF_VIEW = collection(station("A", 1.8, "EUR"), station("B", 1.75, "CHF"), station("C", 1.7, "CHF"));
const RATES = { base: "EUR", rates: { USD: 1.1, CHF: 0.93 }, date: "2026-01-02" };

const wrapper = ({ children }: { children: ReactNode }) => createElement(CurrencyProvider, null, children);

function renderWith(stations: StationsGeoJSONCollection) {
  return renderHook(() => ({ ctx: useCurrency(), out: useConvertedStations(stations) }), { wrapper });
}

describe("CurrencyProvider", () => {
  const originalLanguages = navigator.languages;

  beforeEach(() => {
    localStorage.clear();
    // An English phone in a euro country: the language must not pick the currency.
    Object.defineProperty(navigator, "languages", { value: ["en-US"], configurable: true });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(RATES), { status: 200 })));
  });

  afterEach(() => {
    Object.defineProperty(navigator, "languages", { value: originalLanguages, configurable: true });
    vi.unstubAllGlobals();
  });

  it("shows euro stations in euros when nothing is chosen, whatever the language", async () => {
    const { result } = renderWith(EUR_VIEW);
    await waitFor(() => expect(result.current.ctx.rates).not.toBeNull());
    expect(result.current.ctx.currency).toBe("EUR");
    expect(result.current.ctx.isAuto).toBe(true);
    expect(result.current.out.features[0].properties.price).toBe(1.8);
    expect(result.current.out.features[0].properties.originalCurrency).toBeUndefined();
  });

  it("converts to a currency the user chose", async () => {
    localStorage.setItem("pumperly-currency", "USD");
    const { result } = renderWith(EUR_VIEW);
    await waitFor(() => expect(result.current.ctx.rates).not.toBeNull());
    expect(result.current.ctx.currency).toBe("USD");
    expect(result.current.ctx.isAuto).toBe(false);
    expect(result.current.out.features[0].properties.price).toBeCloseTo(1.98, 6);
    expect(result.current.out.features[0].properties.originalCurrency).toBe("EUR");
  });

  it("follows the most common station currency and converts only the others", async () => {
    const { result } = renderWith(CHF_VIEW);
    await waitFor(() => expect(result.current.ctx.rates).not.toBeNull());
    await waitFor(() => expect(result.current.ctx.currency).toBe("CHF"));
    const [a, b] = result.current.out.features;
    expect(a.properties.currency).toBe("CHF");
    expect(a.properties.price).toBeCloseTo(1.8 * 0.93, 6);
    expect(b.properties.price).toBe(1.75);
    expect(b.properties.originalCurrency).toBeUndefined();
  });

  it("prefers euros on a tie", async () => {
    const { result } = renderWith(collection(station("A", 1.8, "EUR"), station("B", 1.75, "CHF")));
    await waitFor(() => expect(result.current.ctx.rates).not.toBeNull());
    expect(result.current.ctx.currency).toBe("EUR");
  });

  it("converts nothing without rates", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 503 })));
    const { result } = renderWith(CHF_VIEW);
    await waitFor(() => expect(result.current.ctx.currency).toBe("CHF"));
    expect(result.current.out).toBe(CHF_VIEW);
  });

  it("goes back to the pump currency when the choice is cleared", async () => {
    localStorage.setItem("pumperly-currency", "USD");
    const { result } = renderWith(EUR_VIEW);
    await waitFor(() => expect(result.current.ctx.rates).not.toBeNull());
    act(() => result.current.ctx.setCurrency(null));
    expect(localStorage.getItem("pumperly-currency")).toBeNull();
    expect(result.current.ctx.currency).toBe("EUR");
    expect(result.current.ctx.isAuto).toBe(true);
    expect(result.current.out.features[0].properties.price).toBe(1.8);
  });
});
