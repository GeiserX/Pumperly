/** Country definition with map center/zoom for initial view. */
export interface CountryConfig {
  code: string;
  name: string;
  center: [number, number]; // [longitude, latitude]
  zoom: number;
  defaultFuel: string;
}

export const COUNTRIES: Record<string, CountryConfig> = {
  ES: { code: "ES", name: "España", center: [-3.7, 40.4], zoom: 6, defaultFuel: "B7" },
  FR: { code: "FR", name: "France", center: [2.35, 46.85], zoom: 6, defaultFuel: "E10" },
  DE: { code: "DE", name: "Deutschland", center: [10.45, 51.16], zoom: 6, defaultFuel: "E5" },
  IT: { code: "IT", name: "Italia", center: [12.49, 41.9], zoom: 6, defaultFuel: "B7" },
  GB: { code: "GB", name: "United Kingdom", center: [-1.17, 52.35], zoom: 6, defaultFuel: "E5" },
  AT: { code: "AT", name: "Österreich", center: [13.33, 47.52], zoom: 7, defaultFuel: "B7" },
  PT: { code: "PT", name: "Portugal", center: [-8.22, 39.4], zoom: 7, defaultFuel: "B7" },
  SI: { code: "SI", name: "Slovenija", center: [14.99, 46.15], zoom: 8, defaultFuel: "B7" },
  NL: { code: "NL", name: "Nederland", center: [5.29, 52.13], zoom: 7, defaultFuel: "E10" },
  BE: { code: "BE", name: "België", center: [4.47, 50.5], zoom: 8, defaultFuel: "E10" },
  LU: { code: "LU", name: "Luxembourg", center: [6.13, 49.81], zoom: 9, defaultFuel: "E10" },
  RO: { code: "RO", name: "România", center: [24.97, 45.94], zoom: 7, defaultFuel: "B7" },
  GR: { code: "GR", name: "Ελλάδα", center: [23.73, 37.97], zoom: 7, defaultFuel: "B7" },
  IE: { code: "IE", name: "Ireland", center: [-7.69, 53.14], zoom: 7, defaultFuel: "B7" },
  HR: { code: "HR", name: "Hrvatska", center: [15.98, 45.81], zoom: 7, defaultFuel: "B7" },
  CH: { code: "CH", name: "Schweiz", center: [8.23, 46.82], zoom: 8, defaultFuel: "E5" },
  PL: { code: "PL", name: "Polska", center: [19.15, 51.92], zoom: 6, defaultFuel: "E5" },
  CZ: { code: "CZ", name: "Česko", center: [15.47, 49.82], zoom: 7, defaultFuel: "E5" },
  HU: { code: "HU", name: "Magyarország", center: [19.50, 47.16], zoom: 7, defaultFuel: "E5" },
  BG: { code: "BG", name: "България", center: [25.49, 42.73], zoom: 7, defaultFuel: "B7" },
  SK: { code: "SK", name: "Slovensko", center: [19.70, 48.67], zoom: 8, defaultFuel: "E5" },
  DK: { code: "DK", name: "Danmark", center: [9.50, 56.26], zoom: 7, defaultFuel: "E10" },
  SE: { code: "SE", name: "Sverige", center: [18.64, 60.13], zoom: 5, defaultFuel: "E5" },
  NO: { code: "NO", name: "Norge", center: [8.47, 60.47], zoom: 5, defaultFuel: "E5" },
  RS: { code: "RS", name: "Srbija", center: [21.01, 44.02], zoom: 7, defaultFuel: "E5" },
  FI: { code: "FI", name: "Suomi", center: [25.75, 61.92], zoom: 5, defaultFuel: "E10" },
  EE: { code: "EE", name: "Eesti", center: [24.75, 58.60], zoom: 7, defaultFuel: "E5" },
  LV: { code: "LV", name: "Latvija", center: [24.10, 56.95], zoom: 7, defaultFuel: "E5" },
  LT: { code: "LT", name: "Lietuva", center: [23.88, 55.17], zoom: 7, defaultFuel: "E5" },
  BA: { code: "BA", name: "Bosna i Hercegovina", center: [17.68, 43.92], zoom: 7, defaultFuel: "B7" },
  MK: { code: "MK", name: "Северна Македонија", center: [21.75, 41.60], zoom: 8, defaultFuel: "B7" },
  TR: { code: "TR", name: "Türkiye", center: [35.24, 38.96], zoom: 6, defaultFuel: "B7" },
  MD: { code: "MD", name: "Moldova", center: [28.83, 47.01], zoom: 8, defaultFuel: "B7" },
  IS: { code: "IS", name: "Ísland", center: [-18.80, 64.95], zoom: 6, defaultFuel: "B7" },
  AU: { code: "AU", name: "Australia", center: [133.78, -25.27], zoom: 4, defaultFuel: "E10" },
  AR: { code: "AR", name: "Argentina", center: [-63.62, -38.42], zoom: 4, defaultFuel: "E5" },
  MX: { code: "MX", name: "México", center: [-102.55, 23.63], zoom: 5, defaultFuel: "E5" },
};

/**
 * Get runtime config from environment variables.
 * - PUMPERLY_DEFAULT_COUNTRY: ISO code for initial map view (default: ES)
 * - PUMPERLY_ENABLED_COUNTRIES: Comma-separated list of enabled countries (default: all with scrapers)
 * - PUMPERLY_DEFAULT_FUEL: Override default fuel type (default: per-country)
 * - PUMPERLY_SCRAPE_INTERVAL_HOURS: Global scrape interval override (default: per-country defaults)
 * - PUMPERLY_SCRAPE_INTERVAL_XX: Per-country interval in hours, e.g. PUMPERLY_SCRAPE_INTERVAL_FR=0.5
 */
export function getConfig() {
  const defaultCountry = process.env.PUMPERLY_DEFAULT_COUNTRY || "ES";
  const enabledRaw = process.env.PUMPERLY_ENABLED_COUNTRIES;
  const enabledCountries = enabledRaw
    ? enabledRaw.split(",").map((c) => c.trim().toUpperCase()).filter((c) => c in COUNTRIES)
    : Object.keys(COUNTRIES);
  const defaultFuelOverride = process.env.PUMPERLY_DEFAULT_FUEL || null;
  const clusterStations = (process.env.PUMPERLY_CLUSTER_STATIONS ?? "true").toLowerCase() === "true";

  const country = COUNTRIES[defaultCountry] ?? COUNTRIES.ES;
  const defaultFuel = defaultFuelOverride ?? country.defaultFuel;

  return {
    defaultCountry,
    enabledCountries,
    defaultFuel,
    center: country.center,
    zoom: country.zoom,
    clusterStations,
  };
}
