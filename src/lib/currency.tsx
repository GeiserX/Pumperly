"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { StationsGeoJSONCollection, StationGeoJSON } from "@/types/station";

// ---------------------------------------------------------------------------
// Currency definitions — all major world currencies
// ---------------------------------------------------------------------------

// Only currencies with ECB daily exchange rates (+ EUR as base)
export type Currency =
  | "EUR" | "USD" | "GBP" | "CHF" | "JPY" | "CAD" | "AUD" | "NZD"
  | "SEK" | "NOK" | "DKK" | "ISK"
  | "CZK" | "PLN" | "HUF" | "RON" | "BGN"
  | "RSD" | "BAM" | "MKD"
  | "TRY"
  | "CNY" | "HKD" | "KRW"
  | "SGD" | "MYR" | "THB" | "IDR" | "PHP"
  | "INR" | "ILS"
  | "ZAR" | "BRL" | "MXN"
  | "ARS" | "MDL" | "TWD";

export interface CurrencyInfo {
  code: Currency;
  symbol: string;
  label: string;
  /** Decimal places for fuel price display */
  decimals: number;
}

// Only currencies with ECB daily exchange rates (EUR is the base)
export const CURRENCIES: CurrencyInfo[] = [
  { code: "EUR", symbol: "€", label: "Euro", decimals: 3 },
  { code: "USD", symbol: "$", label: "US Dollar", decimals: 3 },
  { code: "GBP", symbol: "£", label: "British Pound", decimals: 3 },
  { code: "CHF", symbol: "CHF", label: "Swiss Franc", decimals: 3 },
  { code: "JPY", symbol: "¥", label: "Japanese Yen", decimals: 0 },
  { code: "CAD", symbol: "CA$", label: "Canadian Dollar", decimals: 3 },
  { code: "AUD", symbol: "A$", label: "Australian Dollar", decimals: 3 },
  { code: "NZD", symbol: "NZ$", label: "New Zealand Dollar", decimals: 3 },
  { code: "SEK", symbol: "kr", label: "Swedish Krona", decimals: 2 },
  { code: "NOK", symbol: "kr", label: "Norwegian Krone", decimals: 2 },
  { code: "DKK", symbol: "kr", label: "Danish Krone", decimals: 2 },
  { code: "ISK", symbol: "kr", label: "Icelandic Króna", decimals: 0 },
  { code: "CZK", symbol: "Kč", label: "Czech Koruna", decimals: 2 },
  { code: "PLN", symbol: "zł", label: "Polish Złoty", decimals: 2 },
  { code: "HUF", symbol: "Ft", label: "Hungarian Forint", decimals: 0 },
  { code: "RON", symbol: "lei", label: "Romanian Leu", decimals: 3 },
  { code: "BGN", symbol: "лв", label: "Bulgarian Lev", decimals: 3 },
  { code: "RSD", symbol: "din", label: "Serbian Dinar", decimals: 0 },
  { code: "BAM", symbol: "KM", label: "Bosnian Mark", decimals: 3 },
  { code: "MKD", symbol: "ден", label: "Macedonian Denar", decimals: 0 },
  { code: "TRY", symbol: "₺", label: "Turkish Lira", decimals: 2 },
  { code: "CNY", symbol: "¥", label: "Chinese Yuan", decimals: 2 },
  { code: "HKD", symbol: "HK$", label: "Hong Kong Dollar", decimals: 2 },
  { code: "KRW", symbol: "₩", label: "South Korean Won", decimals: 0 },
  { code: "SGD", symbol: "S$", label: "Singapore Dollar", decimals: 3 },
  { code: "MYR", symbol: "RM", label: "Malaysian Ringgit", decimals: 2 },
  { code: "THB", symbol: "฿", label: "Thai Baht", decimals: 2 },
  { code: "IDR", symbol: "Rp", label: "Indonesian Rupiah", decimals: 0 },
  { code: "PHP", symbol: "₱", label: "Philippine Peso", decimals: 2 },
  { code: "INR", symbol: "₹", label: "Indian Rupee", decimals: 2 },
  { code: "ILS", symbol: "₪", label: "Israeli Shekel", decimals: 2 },
  { code: "ZAR", symbol: "R", label: "South African Rand", decimals: 2 },
  { code: "BRL", symbol: "R$", label: "Brazilian Real", decimals: 2 },
  { code: "MXN", symbol: "MX$", label: "Mexican Peso", decimals: 2 },
  { code: "ARS", symbol: "AR$", label: "Argentine Peso", decimals: 0 },
  { code: "MDL", symbol: "L", label: "Moldovan Leu", decimals: 2 },
  { code: "TWD", symbol: "NT$", label: "New Taiwan Dollar", decimals: 1 },
];

const CURRENCY_MAP = new Map(CURRENCIES.map((c) => [c.code, c]));

// ---------------------------------------------------------------------------
// Exchange rates (ECB publishes ~30 currencies; others won't convert)
// ---------------------------------------------------------------------------

export interface ExchangeRates {
  base: "EUR";
  rates: Record<string, number>;
  date: string;
}

/**
 * Runtime guard for the /api/exchange-rates payload. The upstream is the ECB
 * feed proxied through our API; if `date` is missing the downstream
 * `new Date(rates.date + ...)` produces an Invalid Date, so we require a
 * string `date`, a string `base`, and a `rates` object before trusting it.
 */
export function isValidExchangeRates(data: unknown): data is ExchangeRates {
  if (typeof data !== "object" || data === null) return false;
  const d = data as Record<string, unknown>;
  return (
    typeof d.rates === "object" &&
    d.rates !== null &&
    typeof d.date === "string" &&
    typeof d.base === "string"
  );
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

interface CurrencyContextValue {
  /** The display currency: the user's choice, else the view's pump currency, else EUR. */
  currency: Currency;
  /** The currency the user picked, or null to show each pump's own currency. */
  chosen: Currency | null;
  /** True when nothing is chosen and prices follow the stations' currency. */
  isAuto: boolean;
  /** Store a choice; null clears it. */
  setCurrency: (c: Currency | null) => void;
  /** useConvertedStations reports the most common currency of what it shows. */
  setViewCurrency: (c: Currency) => void;
  rates: ExchangeRates | null;
  convert: (price: number, from: string) => number;
  symbol: string;
  decimals: number;
  formatPrice: (price: number) => string;
  /** True only when both source and target rates are available */
  isConverted: (from: string) => boolean;
  rateInfo: (from: string) => string | null;
}

const CurrencyContext = createContext<CurrencyContextValue>({
  currency: "EUR",
  chosen: null,
  isAuto: true,
  setCurrency: () => {},
  setViewCurrency: () => {},
  rates: null,
  convert: (p) => p,
  symbol: "€",
  decimals: 3,
  formatPrice: (p) => p.toFixed(3),
  isConverted: () => false,
  rateInfo: () => null,
});

export function CurrencyProvider({ children }: { children: ReactNode }) {
  // Only a stored pick is a choice. Without one, prices stay in the pump's
  // currency (the figure on the pump), whatever the device language.
  const [chosen, setChosen] = useState<Currency | null>(() => {
    if (typeof window === "undefined") return null;
    const stored = localStorage.getItem("pumperly-currency") as Currency | null;
    return stored && CURRENCY_MAP.has(stored) ? stored : null;
  });
  const [viewCurrency, setViewCurrencyState] = useState<Currency | null>(null);
  const currency: Currency = chosen ?? viewCurrency ?? "EUR";

  const [rates, setRates] = useState<ExchangeRates | null>(null);

  useEffect(() => {
    fetch("/api/exchange-rates")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (isValidExchangeRates(data)) setRates(data);
      })
      .catch(() => {});
  }, []);

  const setCurrency = useCallback((c: Currency | null) => {
    setChosen(c);
    if (c) localStorage.setItem("pumperly-currency", c);
    else localStorage.removeItem("pumperly-currency");
  }, []);

  const setViewCurrency = useCallback((c: Currency) => setViewCurrencyState(c), []);

  const info = CURRENCY_MAP.get(currency) ?? CURRENCIES[0];

  const canConvert = useCallback(
    (from: string): boolean => {
      if (from === currency) return false;
      if (!rates) return false;
      const fromRate = from === "EUR" ? 1 : rates.rates[from];
      const toRate = currency === "EUR" ? 1 : rates.rates[currency];
      return fromRate != null && toRate != null;
    },
    [currency, rates],
  );

  const convert = useCallback(
    (price: number, from: string): number => {
      if (from === currency || !rates) return price;
      const fromRate = from === "EUR" ? 1 : rates.rates[from];
      const toRate = currency === "EUR" ? 1 : rates.rates[currency];
      if (!fromRate || !toRate) return price; // rate unavailable — return as-is
      return (price / fromRate) * toRate;
    },
    [currency, rates],
  );

  const formatPrice = useCallback(
    (price: number): string => price.toFixed(info.decimals),
    [info.decimals],
  );

  const isConverted = useCallback(
    (from: string): boolean => canConvert(from),
    [canConvert],
  );

  const rateInfo = useCallback(
    (from: string): string | null => {
      if (!canConvert(from)) return null;
      const fromRate = from === "EUR" ? 1 : rates!.rates[from];
      const toRate = currency === "EUR" ? 1 : rates!.rates[currency];
      const rate = toRate / fromRate;
      const d = new Date(rates!.date + "T12:00:00Z");
      const dateStr = d.toLocaleDateString("en", { day: "numeric", month: "short" });
      const fromSymbol = CURRENCY_MAP.get(from as Currency)?.symbol ?? from;
      return `1 ${fromSymbol} = ${rate.toFixed(4)} ${info.symbol} · ECB ${dateStr}`;
    },
    [canConvert, currency, rates, info.symbol],
  );

  return (
    <CurrencyContext.Provider
      value={{
        currency,
        chosen,
        isAuto: chosen == null,
        setCurrency,
        setViewCurrency,
        rates,
        convert,
        symbol: info.symbol,
        decimals: info.decimals,
        formatPrice,
        isConverted,
        rateInfo,
      }}
    >
      {children}
    </CurrencyContext.Provider>
  );
}

export function useCurrency() {
  return useContext(CurrencyContext);
}

// ---------------------------------------------------------------------------
// Hook: convert all station prices in a GeoJSON collection
// ---------------------------------------------------------------------------

/**
 * The most common currency among priced stations (ties go to EUR), or null for
 * a collection with no price. Only currencies we can display count.
 */
function mostCommonCurrency(stations: StationsGeoJSONCollection): Currency | null {
  const counts = new Map<Currency, number>();
  for (const f of stations.features) {
    const c = f.properties.currency as Currency;
    if (f.properties.price == null || !CURRENCY_MAP.has(c)) continue;
    counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  let best: Currency | null = null;
  let bestCount = 0;
  for (const [c, n] of counts) {
    if (n > bestCount) {
      best = c;
      bestCount = n;
    }
  }
  if (best != null && (counts.get("EUR") ?? 0) === bestCount) return "EUR";
  return best;
}

export function useConvertedStations(stations: StationsGeoJSONCollection): StationsGeoJSONCollection {
  const { convert, currency, isAuto, setViewCurrency, rates, isConverted: canConvert } = useCurrency();

  // With no choice, the display currency is the one most stations here use.
  const viewCurrency = useMemo(() => (isAuto ? mostCommonCurrency(stations) : null), [isAuto, stations]);
  useEffect(() => {
    if (viewCurrency) setViewCurrency(viewCurrency);
  }, [viewCurrency, setViewCurrency]);

  return useMemo(() => {
    if (!rates) return stations;

    let changed = false;
    const features: StationGeoJSON[] = stations.features.map((f) => {
      const nativeCurrency = f.properties.currency;
      const nativePrice = f.properties.price;
      if (nativePrice == null || !canConvert(nativeCurrency)) return f;

      changed = true;
      return {
        ...f,
        properties: {
          ...f.properties,
          price: convert(nativePrice, nativeCurrency),
          currency,
          originalPrice: nativePrice,
          originalCurrency: nativeCurrency,
        },
      };
    });

    return changed ? { type: "FeatureCollection", features } : stations;
  }, [stations, convert, currency, rates, canConvert]);
}
