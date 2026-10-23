import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { StationGeoJSON } from "@/types/station";

// --- Mocks ---------------------------------------------------------------
// react-map-gl/maplibre's <Popup> needs a live MapLibre instance; replace it
// with a plain wrapper so the popup body renders standalone in jsdom.
vi.mock("react-map-gl/maplibre", () => ({
  Popup: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="popup">{children}</div>
  ),
}));

// i18n: echo the key back so we can assert on stable identifiers.
vi.mock("@/lib/i18n", () => ({
  useI18n: () => ({ t: (k: string) => k, locale: "en" }),
}));

// currency: native display (not converted). Keep the real CURRENCIES table so
// symbol/decimals lookups behave like production.
vi.mock("@/lib/currency", async () => {
  const actual = await vi.importActual<typeof import("@/lib/currency")>("@/lib/currency");
  return {
    CURRENCIES: actual.CURRENCIES,
    useCurrency: () => ({ decimals: 3, rateInfo: () => null }),
  };
});

import { StationPopup } from "./station-popup";

function makeStation(overrides: Partial<StationGeoJSON["properties"]> = {}): StationGeoJSON {
  return {
    type: "Feature",
    geometry: { type: "Point", coordinates: [-3.7038, 40.4168] },
    properties: {
      id: "abc-123",
      name: "Repsol Madrid",
      brand: "Repsol",
      address: "Calle Gran Vía 1",
      city: "Madrid",
      price: 1.589,
      reportedAt: null,
      fuelType: "E5",
      currency: "EUR",
      ...overrides,
    },
  };
}

describe("StationPopup", () => {
  it("renders the brand name", () => {
    render(<StationPopup station={makeStation()} onClose={() => {}} />);
    expect(screen.getByText("Repsol")).toBeInTheDocument();
  });

  it("renders the address and city", () => {
    render(<StationPopup station={makeStation()} onClose={() => {}} />);
    expect(screen.getByText("Calle Gran Vía 1")).toBeInTheDocument();
    expect(screen.getByText("Madrid")).toBeInTheDocument();
  });

  it("renders the price with native EUR decimals and unit", () => {
    render(<StationPopup station={makeStation()} onClose={() => {}} />);
    expect(screen.getByText("1.589")).toBeInTheDocument();
    expect(screen.getByText("€/L")).toBeInTheDocument();
  });

  it("renders the human fuel label from FUEL_TYPE_MAP", () => {
    render(<StationPopup station={makeStation({ fuelType: "E5" })} onClose={() => {}} />);
    // E5 → "Gasolina 95" per src/types/fuel.ts
    expect(screen.getByText("Gasolina 95")).toBeInTheDocument();
  });

  it("shows the no-price message when price is null", () => {
    render(
      <StationPopup
        station={makeStation({ price: null })}
        onClose={() => {}}
      />,
    );
    // t() echoes the key; component renders `${t("popup.noPrice")} <label>`.
    expect(screen.getByText(/popup\.noPrice/)).toBeInTheDocument();
    expect(screen.queryByText("€/L")).not.toBeInTheDocument();
  });

  it("renders the action row: directions, show-on-map (pin), copy link, share", () => {
    render(<StationPopup station={makeStation()} onClose={() => {}} />);
    // Navigate is a labelled link to Google Maps directions.
    const nav = screen.getByText("popup.navigate").closest("a")!;
    expect(nav).toHaveAttribute("href", expect.stringContaining("google.com/maps/dir/"));
    // Show-on-map is an icon-only link to the Google Maps pin (search) endpoint.
    const showOnMap = screen.getByLabelText("popup.showOnMap");
    expect(showOnMap).toHaveAttribute("href", expect.stringContaining("google.com/maps/search/"));
    expect(showOnMap.getAttribute("href")).toContain("query=40.4168");
    // The new copy-link and share buttons exist (icon-only, aria-labelled).
    expect(screen.getByLabelText("popup.copyLink")).toBeInTheDocument();
    expect(screen.getByLabelText("popup.share")).toBeInTheDocument();
  });

  it("copy-link writes the station deep-link to the clipboard", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    // jsdom has no real origin/pathname assumptions; deep-link uses window.location.
    render(<StationPopup station={makeStation({ externalId: "4710", country: "ES" })} onClose={() => {}} />);
    (screen.getByLabelText("popup.copyLink") as HTMLButtonElement).click();
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    const copied = writeText.mock.calls[0][0] as string;
    expect(copied).toContain("station=ES%3A4710");
    expect(copied).toContain("lat=40.4168");
    expect(copied).toContain("lng=-3.7038");
    // The layer the popup was opened from travels with the link (#129).
    expect(copied).toContain("fuel=E5");
    vi.unstubAllGlobals();
  });

  it("shows an EV charger's power instead of an empty price", () => {
    render(<StationPopup station={makeStation({ fuelType: "EV", price: null, powerKw: 150 })} onClose={() => {}} />);
    expect(screen.getByText("150")).toBeInTheDocument();
    expect(screen.getByText("kW")).toBeInTheDocument();
    expect(screen.getByText(/popup.maxPower/)).toBeInTheDocument();
    expect(screen.getByText(/popup.priceNotPublished/)).toBeInTheDocument();
    expect(screen.queryByText(/popup.noPrice/)).not.toBeInTheDocument();
  });

  it("says so when an EV charger's power is unknown", () => {
    render(<StationPopup station={makeStation({ fuelType: "EV", price: null })} onClose={() => {}} />);
    expect(screen.getByText("popup.powerUnknown")).toBeInTheDocument();
    expect(screen.queryByText("kW")).not.toBeInTheDocument();
  });

  it("prices a charger per kWh and shows its power next to the label", () => {
    render(<StationPopup station={makeStation({ fuelType: "EV", price: 0.79, powerKw: 22 })} onClose={() => {}} />);
    expect(screen.getByText("0.790")).toBeInTheDocument();
    expect(screen.getByText("€/kWh")).toBeInTheDocument();
    expect(screen.queryByText("€/L")).not.toBeInTheDocument();
    expect(screen.getByText(/· 22 kW/)).toBeInTheDocument();
  });

  it("lists a charger's per-minute and session fees", () => {
    render(
      <StationPopup
        station={makeStation({
          fuelType: "EV",
          price: 0.46,
          evFees: { perMinute: 0.06, afterMin: 240, sessionFee: 1.5 },
        })}
        onClose={() => {}}
      />,
    );
    // i18n is mocked to echo keys, so the "after {n} min" phrase shows as its key.
    expect(screen.getByText("+0.06 €/min popup.feeAfter · +1.50 € popup.perSession")).toBeInTheDocument();
  });

  it("shows a per-minute fee that applies from the start without an 'after'", () => {
    render(
      <StationPopup station={makeStation({ fuelType: "EV", price: 0.59, evFees: { perMinute: 0.1 } })} onClose={() => {}} />,
    );
    expect(screen.getByText("+0.10 €/min")).toBeInTheDocument();
  });

  it("lists every option of a session fee that varies", () => {
    render(
      <StationPopup
        station={makeStation({
          fuelType: "EV",
          price: 0.49,
          evFees: {
            sessionFee: 1,
            sessionFeeRules: [
              { fee: 0.5, from: "06:00", to: "22:00", days: [1, 2, 3, 4, 5] },
              { fee: 1, from: "22:00", to: "06:00" },
              { fee: 0.8, days: [6, 7], other: true },
            ],
          },
        })}
        onClose={() => {}}
      />,
    );
    expect(
      screen.getByText(
        "+0.50 € popup.perSession (06:00–22:00, Mon–Fri) · +1.00 € popup.perSession (22:00–06:00) · " +
          "+0.80 € popup.perSession (Sat, Sun, popup.feeConditions)",
      ),
    ).toBeInTheDocument();
  });

  it("shows no fee line for a charger without fees", () => {
    render(<StationPopup station={makeStation({ fuelType: "EV", price: 0.59 })} onClose={() => {}} />);
    expect(screen.queryByText(/\/min|popup.perSession/)).not.toBeInTheDocument();
  });
});
