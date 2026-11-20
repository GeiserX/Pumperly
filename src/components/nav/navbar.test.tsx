import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

// i18n: echo the key back so we can assert on stable identifiers. Keep the
// real LOCALES table so the language selects render like production.
vi.mock("@/lib/i18n", async () => {
  const actual = await vi.importActual<typeof import("@/lib/i18n")>("@/lib/i18n");
  return {
    LOCALES: actual.LOCALES,
    useI18n: () => ({ t: (k: string) => k, locale: "es", setLocale: () => {} }),
  };
});

vi.mock("@/lib/currency", async () => {
  const actual = await vi.importActual<typeof import("@/lib/currency")>("@/lib/currency");
  return {
    CURRENCIES: actual.CURRENCIES,
    useCurrency: () => ({ currency: "EUR", setCurrency: () => {} }),
  };
});

vi.mock("@/lib/theme", () => ({
  useTheme: () => ({ theme: "light", toggleTheme: () => {} }),
}));

// The stats dropdown fetches on mount; it is hidden on phones and not under test.
vi.mock("./stats-dropdown", () => ({ StatsDropdown: () => null }));

import { Navbar } from "./navbar";

function renderNavbar() {
  return render(
    <Navbar selectedFuel="B7" onFuelChange={() => {}} geoState="idle" onGeolocate={() => {}} />,
  );
}

describe("Navbar", () => {
  it("gives the locate and menu buttons accessible names", () => {
    renderNavbar();
    expect(screen.getByRole("button", { name: "geo.center" })).toBeInTheDocument();
    const menu = screen.getByRole("button", { name: "menu.open" });
    expect(menu).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(menu);
    expect(menu).toHaveAttribute("aria-expanded", "true");
  });

  it("renders the menu items through translation keys, not English literals", () => {
    renderNavbar();
    fireEvent.click(screen.getByRole("button", { name: "menu.open" }));

    for (const key of ["menu.darkMode", "menu.support", "menu.privacy", "menu.terms", "menu.sources"]) {
      expect(screen.getByText(key)).toBeInTheDocument();
    }
    for (const literal of ["Dark mode", "Light mode", "Support", "Privacy Policy", "Terms of Service", "Data Sources"]) {
      expect(screen.queryByText(literal)).not.toBeInTheDocument();
    }
  });
});
